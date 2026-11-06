import { adminHandler, readJson } from "@/lib/admin";
import { authHint } from "@/lib/hints";
import { pruneRuntime } from "@/lib/scheduler";
import { getConfig, reloadConfig } from "@/lib/store";

/**
 * 上游连通性探测。
 *
 * 先试 GET /models：免费、能顺便拿到模型列表。
 * 但 Agent Plan 的 /api/plan/v3 根本没有 /models（实测 404），所以退一步用
 * POST /chat/completions 发一个空 body——缺 model 会在消耗生成之前就被拒（实测 400），
 * 能拿到 400/422 就说明「鉴权通过 + 路由存在」，不花额度。
 */
async function testUpstream(baseUrl: string, apiKey: string) {
  const started = Date.now();
  const base = baseUrl.replace(/\/+$/, "");
  const key = apiKey.trim();
  const auth = { authorization: `Bearer ${key}` };

  const result = (fields: { ok: boolean; status: number; sample?: string[]; detail?: string }) => ({
    ok: fields.ok,
    status: fields.status,
    ms: Date.now() - started,
    sample: fields.sample ?? [],
    detail: fields.detail ?? "",
    hint: fields.ok ? "" : authHint(base, key, fields.status),
  });

  // 第一步：/models
  let modelsStatus = 0;
  try {
    const res = await fetch(`${base}/models`, { headers: auth, signal: AbortSignal.timeout(15_000) });
    modelsStatus = res.status;
    const text = await res.text();
    if (res.ok) {
      let sample: string[] = [];
      try {
        const parsed = JSON.parse(text) as { data?: { id?: string }[] };
        sample = (parsed.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x)).slice(0, 5);
      } catch {
        // 某些上游 /models 不返回 JSON，忽略
      }
      return result({ ok: true, status: res.status, sample });
    }
    if (res.status !== 404 && res.status !== 405) {
      return result({ ok: false, status: res.status, detail: text.slice(0, 300) });
    }
  } catch (err) {
    return result({ ok: false, status: 0, detail: (err as Error).message });
  }

  // 第二步：/models 不存在（Agent Plan 就是这样），改探 chat/completions 路由
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}", // 故意缺 model：在鉴权之后、生成之前被拒，不花额度
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.ok || res.status === 400 || res.status === 422) {
      return result({
        ok: true,
        status: res.status,
        detail: `该上游不提供 /models（HTTP ${modelsStatus}），已用空请求确认 /chat/completions 可达`,
      });
    }
    return result({ ok: false, status: res.status, detail: text.slice(0, 300) });
  } catch (err) {
    return result({ ok: false, status: 0, detail: (err as Error).message });
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