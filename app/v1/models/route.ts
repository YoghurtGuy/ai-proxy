import { connection } from "next/server";
import { extractKey, findKey } from "@/lib/forward";
import { getConfig } from "@/lib/store";
import { modelAllowed } from "@/lib/types";

/**
 * 聚合下游可见的模型列表：先收集配置里显式声明的模型，
 * 如果某个上游写了 "*"，就真的去问一次它的 /models。
 */
export async function GET(req: Request): Promise<Response> {
  await connection();

  const config = await getConfig();
  const presented = extractKey(req);
  if (!presented) {
    return Response.json({ error: { message: "缺少 API key", type: "proxy_error", code: "missing_api_key" } }, { status: 401 });
  }
  const key = findKey(config, presented);
  if (!key || !key.enabled) {
    return Response.json({ error: { message: "API key 无效", type: "proxy_error", code: "invalid_api_key" } }, { status: 401 });
  }

  const models = new Set<string>();
  let needsProbe = false;
  for (const up of config.upstreams) {
    if (!up.enabled) continue;
    if (up.models.includes("*")) needsProbe = true;
    else for (const m of up.models) models.add(m);
  }

  if (needsProbe) {
    for (const up of config.upstreams) {
      if (!up.enabled) continue;
      try {
        const res = await fetch(`${up.baseUrl.replace(/\/+$/, "")}/models`, {
          headers: { authorization: `Bearer ${up.apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) continue;
        const data = (await res.json()) as { data?: { id?: string }[] };
        for (const m of data.data ?? []) if (m.id) models.add(m.id);
        break;
      } catch {
        continue;
      }
    }
  }

  const data = [...models]
    .filter((id) => modelAllowed(key.limits.allowedModels, id))
    .sort()
    .map((id) => ({ id, object: "model", created: 0, owned_by: "ai-proxy" }));

  return Response.json({ object: "list", data }, { headers: { "cache-control": "no-store" } });
}