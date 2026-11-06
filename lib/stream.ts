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
  /** 上游是否真的报了 usage。false 时前端要标注为估算 */
  exact: boolean;
}

interface AnyRecord {
  [key: string]: unknown;
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
  return { pt, ct, exact: true };
}

export function lineScanner() {
  let buffer = "";
  let totals: UsageTotals = { pt: 0, ct: 0, exact: false };
  const decoder = new TextDecoder();

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
    onFirstByte?: () => void;
    onDone: (usage: UsageTotals, completed: boolean) => void;
  },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const scanner = lineScanner();
  let settled = false;
  let sawFirst = false;

  const settle = (completed: boolean) => {
    if (settled) return;
    settled = true;
    handlers.onDone(scanner.finish(), completed);
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