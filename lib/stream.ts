/**
 * 流式响应的用量提取。
 *
 * 上游 SSE 的 usage 一般只出现在最后一个 chunk，而且 chunk 边界会把 JSON 切断，
 * 所以必须按行缓冲。这里用「手写 ReadableStream + pull」而不是 TransformStream，
 * 因为需要拿到 cancel 回调，客户端断开时也能把并发槽还回去。
 */

export interface UsageTotals {
  pt: number;
  ct: number;
  /** 缓存命中的输入 token 数（仅大于 0 时存在） */
  cachedPt?: number;
  /** 上游是否真的报了 usage。false 时前端要标注为估算 */
  exact: boolean;
}

export interface CapturedOutput {
  content: string;
  reasoning: string;
  toolCalls: unknown[];
  truncated: boolean;
}

interface AnyRecord {
  [key: string]: unknown;
}

interface ToolCallAcc {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments: string;
  };
}

const BASE64_DATA_URI_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{256,}/gi;

/** 脱敏超长 Base64 媒体内容，并按 UTF-8 字节上限安全截断。 */
export function prepareTraceBody(raw: string, maxBytes: number): { text: string; truncated: boolean } {
  const sanitized = raw.replace(BASE64_DATA_URI_RE, (m) => `[base64 omitted: ${m.length} chars]`);
  if (maxBytes <= 0) return { text: "", truncated: sanitized.length > 0 };
  const buf = Buffer.from(sanitized, "utf8");
  if (buf.length <= maxBytes) return { text: sanitized, truncated: false };
  const sliced = buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
  return { text: sliced, truncated: true };
}

/** 兼容 OpenAI（prompt_tokens/completion_tokens）和 Anthropic（input_tokens/output_tokens）两种命名。 */
function extractUsage(node: unknown): UsageTotals | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as AnyRecord;
  const candidate = (obj.usage ?? (obj.response as AnyRecord | undefined)?.usage) as AnyRecord | undefined;
  if (!candidate || typeof candidate !== "object") return null;
  const pt = Number(candidate.prompt_tokens ?? candidate.input_tokens ?? 0);
  const ct = Number(candidate.completion_tokens ?? candidate.output_tokens ?? 0);
  if (!Number.isFinite(pt) || !Number.isFinite(ct)) return null;
  // 全是 0 视为无效上报（有些上游会塞一个空 usage）
  if (pt === 0 && ct === 0) return null;
  const promptDetails = (candidate.prompt_tokens_details ?? candidate.input_tokens_details) as AnyRecord | undefined;
  const rawCached = Number(promptDetails?.cached_tokens ?? candidate.cache_read_input_tokens ?? 0);
  const cachedPt = Number.isFinite(rawCached) && rawCached > 0 ? rawCached : 0;
  return cachedPt > 0 ? { pt, ct, cachedPt, exact: true } : { pt, ct, exact: true };
}

export function lineScanner(captureMaxBytes = 0) {
  let buffer = "";
  let totals: UsageTotals = { pt: 0, ct: 0, exact: false };
  const decoder = new TextDecoder();

  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls = new Map<number, ToolCallAcc>();
  let capturedBytes = 0;
  let capturedTruncated = false;

  const appendText = (target: string[], text: unknown) => {
    if (typeof text !== "string" || !text || capturedTruncated) return;
    const len = Buffer.byteLength(text, "utf8");
    if (capturedBytes + len > captureMaxBytes) {
      const remain = Math.max(0, captureMaxBytes - capturedBytes);
      if (remain > 0) {
        const sliced = Buffer.from(text, "utf8").subarray(0, remain).toString("utf8").replace(/\uFFFD+$/, "");
        if (sliced) target.push(sliced);
      }
      capturedBytes = captureMaxBytes;
      capturedTruncated = true;
      return;
    }
    target.push(text);
    capturedBytes += len;
  };

  const captureDelta = (node: unknown) => {
    if (captureMaxBytes <= 0 || capturedTruncated || !node || typeof node !== "object") return;
    const obj = node as AnyRecord;

    const choices = Array.isArray(obj.choices) ? obj.choices : null;
    if (choices && choices[0] && typeof choices[0] === "object") {
      const c0 = choices[0] as AnyRecord;
      if (typeof c0.text === "string") appendText(contentParts, c0.text);
      const delta = c0.delta as AnyRecord | undefined;
      if (delta && typeof delta === "object") {
        appendText(contentParts, delta.content);
        appendText(reasoningParts, delta.reasoning_content ?? delta.reasoning);
        if (Array.isArray(delta.tool_calls)) {
          for (const rawTc of delta.tool_calls) {
            if (!rawTc || typeof rawTc !== "object") continue;
            const tc = rawTc as AnyRecord;
            const idx = typeof tc.index === "number" ? tc.index : 0;
            let acc = toolCalls.get(idx);
            if (!acc) {
              acc = {};
              toolCalls.set(idx, acc);
            }
            if (typeof tc.id === "string" && tc.id) acc.id = tc.id;
            if (typeof tc.type === "string" && tc.type) acc.type = tc.type;
            const fn = tc.function as AnyRecord | undefined;
            if (fn && typeof fn === "object") {
              acc.function ??= { arguments: "" };
              if (typeof fn.name === "string" && fn.name) acc.function.name = fn.name;
              if (typeof fn.arguments === "string" && fn.arguments && !capturedTruncated) {
                const len = Buffer.byteLength(fn.arguments, "utf8");
                if (capturedBytes + len > captureMaxBytes) {
                  capturedTruncated = true;
                } else {
                  acc.function.arguments += fn.arguments;
                  capturedBytes += len;
                }
              }
            }
          }
        }
      }
    }

    // 兼容 Anthropic / Responses API 文本 delta
    const delta = obj.delta as AnyRecord | undefined;
    if (delta && typeof delta === "object") {
      if (typeof delta.text === "string") appendText(contentParts, delta.text);
      if (typeof delta.thinking === "string") appendText(reasoningParts, delta.thinking);
    } else if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
      appendText(contentParts, obj.delta);
    } else if (obj.type === "response.reasoning_summary_text.delta" && typeof obj.delta === "string") {
      appendText(reasoningParts, obj.delta);
    }
  };

  const scanLine = (raw: string) => {
    const line = raw.trim();
    if (!line || line.startsWith(":") || line.startsWith("event:") || line.startsWith("id:")) return;
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!payload || payload === "[DONE]") return;
    if (!payload.startsWith("{")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const found = extractUsage(parsed);
    if (found) totals = found;
    captureDelta(parsed);
  };

  return {
    feed(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        scanLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
      }
      // 防御：上游不发换行时别把内存吃光
      if (buffer.length > 256 * 1024) buffer = buffer.slice(-4096);
    },
    finish() {
      buffer += decoder.decode();
      for (const line of buffer.split("\n")) scanLine(line);
      buffer = "";
      return totals;
    },
    get totals() {
      return totals;
    },
    get captured(): CapturedOutput | null {
      if (captureMaxBytes <= 0) return null;
      const content = contentParts.join("");
      const reasoning = reasoningParts.join("");
      const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      if (!content && !reasoning && calls.length === 0) return null;
      return { content, reasoning, toolCalls: calls, truncated: capturedTruncated };
    },
  };
}

/** 从非流式响应体里取 usage。 */
export function usageFromJsonBody(text: string): UsageTotals {
  try {
    const parsed = JSON.parse(text);
    return extractUsage(parsed) ?? { pt: 0, ct: 0, exact: false };
  } catch {
    return { pt: 0, ct: 0, exact: false };
  }
}

/**
 * 把上游 body 原样转给客户端，同时旁路提取 usage。
 * onDone 一定会在「正常读完」或「客户端断开」时触发一次。
 */
export function tapStream(
  body: ReadableStream<Uint8Array>,
  handlers: {
    captureMaxBytes?: number;
    onFirstByte?: () => void;
    onDone: (usage: UsageTotals, completed: boolean, captured?: CapturedOutput | null) => void;
  },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const scanner = lineScanner(handlers.captureMaxBytes ?? 0);
  let settled = false;
  let sawFirst = false;

  const settle = (completed: boolean) => {
    if (settled) return;
    settled = true;
    handlers.onDone(scanner.finish(), completed, scanner.captured);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read().catch(() => null);
      if (result === null) {
        settle(false);
        controller.error(new Error("upstream stream failed"));
        return;
      }
      if (result.done) {
        settle(true);
        controller.close();
        return;
      }
      if (!sawFirst) {
        sawFirst = true;
        handlers.onFirstByte?.();
      }
      scanner.feed(result.value);
      controller.enqueue(result.value);
    },
    cancel(reason) {
      settle(false);
      return reader.cancel(reason);
    },
  });
}