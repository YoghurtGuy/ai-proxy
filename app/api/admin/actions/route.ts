import { adminHandler, readJson } from "@/lib/admin";
import { pruneRuntime } from "@/lib/scheduler";
import { getConfig, reloadConfig } from "@/lib/store";

/** 上游连通性探测：打它的 /models，不消耗生成额度。 */
async function testUpstream(baseUrl: string, apiKey: string) {
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let sample: string[] = [];
    try {
      const parsed = JSON.parse(text) as { data?: { id?: string }[] };
      sample = (parsed.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x)).slice(0, 5);
    } catch {
      // 有些上游 /models 不返回 JSON，保留原始片段给前端看
    }
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      sample,
      detail: res.ok ? "" : text.slice(0, 300),
    };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, sample: [], detail: (err as Error).message };
  }
}

export async function POST(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const body = await readJson(req);
    const action = String(body.action ?? "");

    if (action === "reload") {
      const config = await reloadConfig();
      pruneRuntime(config);
      return Response.json({ ok: true, upstreams: config.upstreams.length, keys: config.keys.length });
    }

    if (action === "testUpstream") {
      const config = await getConfig();
      const up = config.upstreams.find((u) => u.id === String(body.id ?? ""));
      if (!up) return Response.json({ error: "上游不存在" }, { status: 404 });
      return Response.json({ ok: true, result: await testUpstream(up.baseUrl, up.apiKey) });
    }

    return Response.json({ error: `未知操作: ${action}` }, { status: 400 });
  });
}