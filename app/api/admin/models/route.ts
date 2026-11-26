import { adminHandler, readJson } from "@/lib/admin";
import { listUpstreamModels } from "@/lib/models";
import { summarize, todayBuckets } from "@/lib/stats";
import { getConfig, updateConfig } from "@/lib/store";
import { calculateModelCost, normalizeModelPrices } from "@/lib/types";

export async function GET(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const url = new URL(req.url);
    const refresh = url.searchParams.get("refresh") === "1";
    const config = await getConfig();
    const buckets = todayBuckets();

    const resolved = await Promise.all(
      config.upstreams
        .filter((u) => u.enabled)
        .map(async (u) => ({
          up: u,
          res: await listUpstreamModels(u, { refresh }),
        })),
    );

    const map = new Map<
      string,
      {
        id: string;
        upstreams: { id: string; name: string }[];
      }
    >();

    const ensure = (id: string) => {
      let entry = map.get(id);
      if (!entry) {
        entry = { id, upstreams: [] };
        map.set(id, entry);
      }
      return entry;
    };

    for (const { up, res } of resolved) {
      for (const m of res.models) {
        if (!m || m === "*") continue;
        const entry = ensure(m);
        if (!entry.upstreams.some((x) => x.id === up.id)) {
          entry.upstreams.push({ id: up.id, name: up.name });
        }
      }
    }

    for (const m of Object.keys(config.modelPrices)) {
      ensure(m);
    }

    for (const dim of Object.keys(buckets)) {
      if (!dim.startsWith("model:")) continue;
      const m = dim.slice("model:".length);
      if (m) ensure(m);
    }

    const models = [...map.values()]
      .map((item) => {
        const pricing = config.modelPrices[item.id] ?? null;
        const summary = summarize(buckets[`model:${item.id}`]);
        const cost = pricing ? calculateModelCost(summary.pt, summary.ct, summary.cachedPt, pricing) : null;
        return {
          ...item,
          pricing,
          today: { ...summary, cost },
        };
      })
      .sort((a, b) => {
        if (b.today.req !== a.today.req) return b.today.req - a.today.req;
        if (Boolean(b.pricing) !== Boolean(a.pricing)) return b.pricing ? 1 : -1;
        return a.id.localeCompare(b.id);
      });

    return Response.json({ models });
  });
}

export async function PUT(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const body = (await readJson(req)) as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) return Response.json({ error: "model 不能为空" }, { status: 400 });

    const remove = body.remove === true;
    const config = await updateConfig((c) => {
      if (remove) {
        const next = { ...c.modelPrices };
        delete next[model];
        c.modelPrices = next;
        return;
      }
      const parsed = normalizeModelPrices({
        [model]: {
          inputPerM: body.inputPerM,
          cachedInputPerM: body.cachedInputPerM,
          outputPerM: body.outputPerM,
        },
      });
      c.modelPrices = { ...c.modelPrices, ...parsed };
    });

    return Response.json({ ok: true, pricing: config.modelPrices[model] ?? null });
  });
}
