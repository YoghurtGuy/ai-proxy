import { adminHandler, readJson } from "@/lib/admin";
import { listUpstreamModels } from "@/lib/models";
import { getTodayBuckets, summarize } from "@/lib/stats";
import { getConfig, updateConfig } from "@/lib/store";
import {
  calculateModelCost,
  canonicalModelName,
  findModelPricing,
  mergeBuckets,
  normalizeModelPrices,
  type Bucket,
} from "@/lib/types";

export async function GET(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const url = new URL(req.url);
    const refresh = url.searchParams.get("refresh") === "1";
    const config = await getConfig();
    const buckets = await getTodayBuckets();

    const enabledUpstreams = config.upstreams.filter((u) => u.enabled);
    const resolved = await Promise.all(
      enabledUpstreams.map(async (u) => {
        if (!u.models.includes("*")) {
          return { up: u, models: u.models };
        }
        const res = await listUpstreamModels(u, { refresh });
        return { up: u, models: res.models };
      }),
    );

    const map = new Map<
      string,
      {
        id: string;
        aliases: string[];
        upstreams: { id: string; name: string }[];
      }
    >();

    const ensure = (rawName: string) => {
      const id = canonicalModelName(rawName);
      let entry = map.get(id);
      if (!entry) {
        entry = { id, aliases: [], upstreams: [] };
        map.set(id, entry);
      }
      const trimmed = rawName.trim();
      if (trimmed && trimmed !== id && !entry.aliases.includes(trimmed)) {
        entry.aliases.push(trimmed);
      }
      return entry;
    };

    for (const { up, models } of resolved) {
      for (const m of models) {
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

    const mergedBuckets = new Map<string, Bucket>();
    for (const [dim, bucket] of Object.entries(buckets)) {
      if (!dim.startsWith("model:")) continue;
      const rawModel = dim.slice("model:".length).trim();
      if (!rawModel) continue;
      const entry = ensure(rawModel);
      const prev = mergedBuckets.get(entry.id);
      mergedBuckets.set(entry.id, prev ? mergeBuckets(prev, bucket) : bucket);
    }

    const models = [...map.values()]
      .map((item) => {
        const pricing = findModelPricing(config.modelPrices, item.id);
        const summary = summarize(mergedBuckets.get(item.id));
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
    const rawModel = typeof body.model === "string" ? body.model.trim() : "";
    if (!rawModel) return Response.json({ error: "model 不能为空" }, { status: 400 });

    const canonical = canonicalModelName(rawModel);
    const remove = body.remove === true;
    const config = await updateConfig((c) => {
      const next = { ...c.modelPrices };
      for (const existingKey of Object.keys(next)) {
        if (canonicalModelName(existingKey) === canonical) {
          delete next[existingKey];
        }
      }
      if (remove) {
        c.modelPrices = next;
        return;
      }
      const parsed = normalizeModelPrices({
        [canonical]: {
          inputPerM: body.inputPerM,
          cachedInputPerM: body.cachedInputPerM,
          outputPerM: body.outputPerM,
        },
      });
      c.modelPrices = { ...next, ...parsed };
    });

    return Response.json({ ok: true, model: canonical, pricing: config.modelPrices[canonical] ?? null });
  });
}
