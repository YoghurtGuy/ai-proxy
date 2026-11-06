/**
 * 本地模拟上游，用来端到端验证转发、SSE 计量和 429 换号。
 *   bun scripts/mock-upstream.ts [port]
 */
const port = Number(process.argv[2] ?? 8787);
const enc = new TextEncoder();

function sse(chunks: string[], delayMs = 10): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "mock-model" }, { id: "mock-stream" }] });
    }

    if (url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/completions")) {
      const body = (await req.json()) as { model?: string; stream?: boolean; messages?: unknown[] };
      const model = body.model ?? "";

      // 专门用来测换号的模型
      if (model === "always-429") {
        return Response.json(
          { error: { message: "This model is rate limited" } },
          { status: 429, headers: { "retry-after": "7" } },
        );
      }
      if (model === "always-500") {
        return new Response("<html>boom</html>", { status: 500, headers: { "content-type": "text/html" } });
      }

      if (body.stream) {
        // 故意把 usage 的 JSON 切成两半，验证扫描器的行缓冲
        return new Response(
          sse([
            'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
            'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":',
            "12,\"completion_tokens\":34}}\n\n",
            "data: [DONE]\n\n",
          ]),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
        );
      }

      return Response.json({
        id: "mock-1",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: `收到 ${body.messages?.length ?? 0} 条消息` } }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      });
    }

    return Response.json({ error: { message: `mock 不认识这个路径: ${url.pathname}` } }, { status: 404 });
  },
});

console.log(`mock upstream listening on http://127.0.0.1:${server.port}/api/v3`);