import { connection } from "next/server";
import { extractKey, findKey } from "@/lib/forward";
import { listUpstreamModels } from "@/lib/models";
import { getConfig } from "@/lib/store";
import { modelAllowed } from "@/lib/types";

/**
 * 聚合下游可见的模型列表。
 * 每个上游的模型来源可能是数据面 /models、Agent Plan 管控面接口或配置里写死的，
 * 具体见 lib/models.ts。
 */
export async function GET(req: Request): Promise<Response> {
  await connection();

  const config = await getConfig();
  const presented = extractKey(req);
  if (!presented) {
    return Response.json(
      { error: { message: "缺少 API key", type: "proxy_error", code: "missing_api_key" } },
      { status: 401 },
    );
  }
  const key = findKey(config, presented);
  if (!key || !key.enabled) {
    return Response.json(
      { error: { message: "API key 无效", type: "proxy_error", code: "invalid_api_key" } },
      { status: 401 },
    );
  }

  const enabled = config.upstreams.filter((up) => up.enabled);
  const resolved = await Promise.all(
    enabled.map(async (up) => ({ up, result: await listUpstreamModels(up) })),
  );

  const modelIds = new Set<string>();
  for (const { result } of resolved) {
    for (const id of result.models) modelIds.add(id);
  }

  const data = [...modelIds]
    .filter((id) => modelAllowed(key.limits.allowedModels, id))
    .sort()
    .map((id) => ({ id, object: "model", created: 0, owned_by: "ai-proxy" }));

  return Response.json({ object: "list", data }, { headers: { "cache-control": "no-store" } });
}