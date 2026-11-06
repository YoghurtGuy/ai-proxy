import { adminHandler, readJson } from "@/lib/admin";
import { pruneRuntime } from "@/lib/scheduler";
import { getConfig, newDownstreamKey, newId, updateConfig } from "@/lib/store";
import type { DownstreamKey } from "@/lib/types";

export async function GET(): Promise<Response> {
  return adminHandler(async () => {
    const config = await getConfig();
    return Response.json({ keys: config.keys });
  });
}

export async function POST(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const body = await readJson(req);
    const config = await updateConfig((c) => {
      c.keys.push({
        ...body,
        id: newId("k"),
        key: typeof body.key === "string" && body.key.trim() ? body.key.trim() : newDownstreamKey(),
      } as unknown as DownstreamKey);
    });
    pruneRuntime(config);
    return Response.json({ ok: true, keys: config.keys }, { status: 201 });
  });
}

export async function PUT(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const body = await readJson(req);
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
    const config = await updateConfig((c) => {
      const index = c.keys.findIndex((k) => k.id === id);
      if (index < 0) throw new Error("key 不存在");
      const merged = { ...c.keys[index], ...body, id } as DownstreamKey;
      // limits 是嵌套对象，需要逐层合并，否则改一个字段会丢其他字段
      merged.limits = { ...c.keys[index].limits, ...((body.limits as object) ?? {}) } as DownstreamKey["limits"];
      c.keys[index] = merged;
    });
    pruneRuntime(config);
    return Response.json({ ok: true, keys: config.keys });
  });
}

export async function DELETE(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
    const config = await updateConfig((c) => {
      c.keys = c.keys.filter((k) => k.id !== id);
    });
    pruneRuntime(config);
    return Response.json({ ok: true });
  });
}