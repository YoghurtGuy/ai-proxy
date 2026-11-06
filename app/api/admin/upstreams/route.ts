import { adminHandler, readJson } from "@/lib/admin";
import { fetchVolcengineQuota } from "@/lib/quota/volcengine";
import { clearCooldown, pruneRuntime, setQuota, upstreamSnapshot } from "@/lib/scheduler";
import { getConfig, newId, updateConfig } from "@/lib/store";
import type { Upstream } from "@/lib/types";

export async function GET(): Promise<Response> {
  return adminHandler(async () => {
    const config = await getConfig();
    const runtime = upstreamSnapshot();
    return Response.json({
      upstreams: config.upstreams.map((up) => ({ ...up, runtime: runtime[up.id] ?? null })),
    });
  });
}

export async function POST(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const body = await readJson(req);
    const config = await updateConfig((c) => {
      c.upstreams.push({ ...body, id: newId("u") } as unknown as Upstream);
    });
    pruneRuntime(config);
    return Response.json({ ok: true, upstreams: config.upstreams }, { status: 201 });
  });
}

export async function PUT(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const body = await readJson(req);
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
    const config = await updateConfig((c) => {
      const index = c.upstreams.findIndex((u) => u.id === id);
      if (index < 0) throw new Error("上游不存在");
      c.upstreams[index] = { ...c.upstreams[index], ...body, id } as Upstream;
    });
    pruneRuntime(config);
    return Response.json({ ok: true, upstreams: config.upstreams });
  });
}

export async function DELETE(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
    const config = await updateConfig((c) => {
      c.upstreams = c.upstreams.filter((u) => u.id !== id);
    });
    pruneRuntime(config);
    return Response.json({ ok: true });
  });
}

/** 立即刷新某个上游的套餐额度，并清掉它的冷却。 */
export async function PATCH(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const body = await readJson(req);
    const id = String(body.id ?? "");
    const config = await getConfig();
    const up = config.upstreams.find((u) => u.id === id);
    if (!up) return Response.json({ error: "上游不存在" }, { status: 404 });

    if (body.action === "clearCooldown") {
      clearCooldown(id);
      return Response.json({ ok: true });
    }
    if (!up.quota?.accessKey) return Response.json({ error: "该上游没有配置 AK/SK" }, { status: 400 });

    const snapshot = await fetchVolcengineQuota(up.quota);
    setQuota(id, snapshot);
    return Response.json({ ok: true, quota: snapshot });
  });
}