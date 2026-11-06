import { adminHandler, readJson } from "@/lib/admin";
import { getConfig, updateConfig } from "@/lib/store";
import { normalizeSettings } from "@/lib/types";

export async function GET(): Promise<Response> {
  return adminHandler(async () => {
    const config = await getConfig();
    return Response.json({ settings: config.settings });
  });
}

export async function PUT(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const body = await readJson(req);
    const config = await updateConfig((c) => {
      c.settings = normalizeSettings({ ...c.settings, ...body });
    });
    return Response.json({ ok: true, settings: config.settings });
  });
}