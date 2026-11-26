/**
 * 断言式自检，不引测试框架。用 bun 跑：
 *   bun scripts/self-check.ts
 *
 * 重点是三块最容易写错、错了又不会立刻报错的东西：
 * 1. 火山 Signature V4（对着官方手册的测试向量核对）
 * 2. 调度器的冷却/并发/粘性
 * 3. SSE 分块里的 usage 提取
 */
import assert from "node:assert/strict";
import { lineScanner, prepareTraceBody } from "../lib/stream";
import { generateLogId } from "../lib/mysql";
import { handleProxy, parseCooldownMs, sessionHash, shouldFallbackFromFlex } from "../lib/forward";
import {
  checkSlopeLimit,
  markCooldown,
  releaseUpstream,
  resetSlopeState,
  selectAndAcquire,
  slopeScope,
  upState,
  waitForUpstreamSlot,
} from "../lib/scheduler";
import {
  calculateModelCost,
  canonicalModelName,
  findModelPricing,
  isFlexWindowActive,
  mergeBuckets,
  normalizeConfig,
} from "../lib/types";
import { formatCost } from "../lib/format";
import { authHint } from "../lib/hints";
import { signRequest, fetchVolcengineQuota, listAgentPlanModels } from "../lib/quota/volcengine";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// 1. Signature V4 —— 用例和期望值直接来自火山引擎《签名方法》文档
// ---------------------------------------------------------------------------

// 用例和期望签名来自火山引擎《签名方法》文档。Access Key ID 只出现在 Authorization
// 字符串里、不参与 HMAC 运算，所以换成占位值不影响签名结果；Secret 必须保留原值
// 才能复现文档给出的期望签名。
const DOC_AK = "doc-example-access-key";
const DOC_SK = "WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUxTXpZeU9UVXlOMlE1TmpZeVlqTQ==";
const DOC_DATE = new Date("2025-03-29T18:09:37Z");

check("SigV4 GET 官方向量", () => {
  const { signature } = signRequest({
    method: "GET",
    host: "billing.volcengineapi.com",
    query: { Action: "QueryBalanceAcct", Version: "2022-01-01" },
    body: "",
    region: "cn-beijing",
    service: "billing",
    accessKey: DOC_AK,
    secretKey: DOC_SK,
    now: DOC_DATE,
    signedHeaders: ["host", "x-date"],
  });
  assert.equal(signature, "1eda9e7e6b1728151a8e8791fdaf67cfbd28bd5c80d0fce2eb208746cf483105");
});

check("SigV4 POST 官方向量", () => {
  const { signature } = signRequest({
    method: "POST",
    host: "billing.volcengineapi.com",
    query: { Action: "ListBill", Version: "2022-01-01" },
    body: '{"Limit":10,"BillPeriod":"2023-08"}',
    region: "cn-beijing",
    service: "billing",
    accessKey: DOC_AK,
    secretKey: DOC_SK,
    now: DOC_DATE,
    signedHeaders: ["host", "x-date"],
  });
  assert.equal(signature, "5e8480ceea12d0000a23c054151c50dd02c1a7dec835004057d19f13d53a7658");
});

check("SigV4 改 body 会改签名", () => {
  const base = {
    method: "POST",
    host: "ark.cn-beijing.volcengineapi.com",
    query: { Action: "GetAFPUsage", Version: "2024-01-01" },
    region: "cn-beijing",
    service: "ark",
    accessKey: DOC_AK,
    secretKey: DOC_SK,
    now: DOC_DATE,
  } as const;
  const a = signRequest({ ...base, body: "{}" }).signature;
  const b = signRequest({ ...base, body: '{"x":1}' }).signature;
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

check("SigV4 Authorization 头结构", () => {
  const { headers } = signRequest({
    method: "POST",
    host: "ark.cn-beijing.volcengineapi.com",
    query: { Action: "GetAFPUsage", Version: "2024-01-01" },
    body: "{}",
    region: "cn-beijing",
    service: "ark",
    accessKey: DOC_AK,
    secretKey: DOC_SK,
    now: DOC_DATE,
  });
  assert.equal(
    headers.Authorization.startsWith(`HMAC-SHA256 Credential=${DOC_AK}/20250329/cn-beijing/ark/request, `),
    true,
  );
  assert.match(headers.Authorization, /SignedHeaders=host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/);
  assert.equal(headers["X-Date"], "20250329T180937Z");
  assert.equal(headers["X-Content-Sha256"], "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"); // sha256("{}")
});

// ---------------------------------------------------------------------------
// 2. 调度器
// ---------------------------------------------------------------------------

function mkConfig(upstreams: unknown[], overrides: Record<string, unknown> = {}) {
  return normalizeConfig({ upstreams, keys: [], settings: overrides });
}

const up = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  baseUrl: "https://example.com/api/v3",
  apiKey: "k",
  models: ["*"],
  concurrency: 2,
  ...extra,
});

check("冷却中的上游被跳过", () => {
  const config = mkConfig([up("cool_a", { priority: 1 }), up("cool_b", { priority: 50 })]);
  markCooldown("cool_a", 60_000, "429");
  const picked = selectAndAcquire(config, "m", "");
  assert.equal(picked.up?.id, "cool_b");
  if (picked.up) releaseUpstream(picked.up.id);
});

check("全部冷却时返回 all_cooling", () => {
  const config = mkConfig([up("cool_c"), up("cool_d")]);
  markCooldown("cool_c", 60_000, "429");
  markCooldown("cool_d", 60_000, "429");
  const picked = selectAndAcquire(config, "m", "");
  assert.equal(picked.up, null);
  assert.equal(picked.reason, "all_cooling");
});

check("并发槽满时返回 all_busy", () => {
  const config = mkConfig([up("busy_a", { concurrency: 1 })]);
  const first = selectAndAcquire(config, "m", "");
  assert.equal(first.up?.id, "busy_a");
  const second = selectAndAcquire(config, "m", "");
  assert.equal(second.up, null);
  assert.equal(second.reason, "all_busy");
  if (first.up) releaseUpstream(first.up.id);
  const third = selectAndAcquire(config, "m", "");
  assert.equal(third.up?.id, "busy_a");
  if (third.up) releaseUpstream(third.up.id);
});

check("模型不匹配返回 no_model", () => {
  const config = mkConfig([up("model_a", { models: ["only-this"] })]);
  const picked = selectAndAcquire(config, "other-model", "");
  assert.equal(picked.up, null);
  assert.equal(picked.reason, "no_model");
});

check("粘性会话稳定命中同一上游", () => {
  const config = mkConfig([up("sticky_a"), up("sticky_b"), up("sticky_c")]);
  const hash = "session-xyz";
  const first = selectAndAcquire(config, "m", hash);
  assert.ok(first.up);
  releaseUpstream(first.up!.id);
  for (let i = 0; i < 8; i++) {
    const again = selectAndAcquire(config, "m", hash);
    assert.equal(again.up?.id, first.up!.id);
    releaseUpstream(again.up!.id);
  }
});

check("排除已失败的 id", () => {
  const config = mkConfig([up("ex_a"), up("ex_b")]);
  const picked = selectAndAcquire(config, "m", "", new Set(["ex_a"]));
  assert.equal(picked.up?.id, "ex_b");
  if (picked.up) releaseUpstream(picked.up.id);
});

check("额度见底的上游被跳过", () => {
  const config = mkConfig([
    up("quota_a", { quota: { provider: "volcengine-afp", accessKey: "a", secretKey: "b", minRemainingPct: 5 } }),
    up("quota_b"),
  ]);
  upState("quota_a").quota = {
    remainingPct: 1,
    windows: { daily: { quota: 100, used: 99, resetTime: 0 } },
    fetchedAt: Date.now(),
  };
  const picked = selectAndAcquire(config, "m", "");
  assert.equal(picked.up?.id, "quota_b");
  if (picked.up) releaseUpstream(picked.up.id);
});

// ---------------------------------------------------------------------------
// 3. 429 冷却时长解析
// ---------------------------------------------------------------------------

const settings = normalizeConfig({}).settings;

check("retry-after 秒", () => {
  const ms = parseCooldownMs(new Headers({ "retry-after": "30" }), "", settings);
  assert.equal(ms, 30_000);
});

check("x-ratelimit-reset-requests 的 6m0s", () => {
  const ms = parseCooldownMs(new Headers({ "x-ratelimit-reset-requests": "6m0s" }), "", settings);
  assert.equal(ms, 360_000);
});

check("OpenAI 文案里的 1.5s", () => {
  const body = '{"error":{"message":"Rate limit reached, please try again in 1.5s."}}';
  assert.equal(parseCooldownMs(new Headers(), body, settings), 1500);
});

check("没有线索时用兜底值并受上限约束", () => {
  assert.equal(parseCooldownMs(new Headers(), "", settings), settings.cooldownDefaultSec * 1000);
  const huge = parseCooldownMs(new Headers({ "retry-after": "999999" }), "", settings);
  assert.equal(huge, settings.cooldownMaxSec * 1000);
});

// ---------------------------------------------------------------------------
// 4. SSE usage 提取（含跨 chunk 截断）
// ---------------------------------------------------------------------------

check("usage 在最后一行正常提取", () => {
  const s = lineScanner();
  s.feed(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
  s.feed(new TextEncoder().encode('data: {"usage":{"prompt_tokens":11,"completion_tokens":22}}\n\n'));
  const totals = s.finish();
  assert.deepEqual(totals, { pt: 11, ct: 22, exact: true });
});

check("JSON 被 chunk 边界切断也能提取", () => {
  const s = lineScanner();
  const bytes = new TextEncoder().encode('data: {"usage":{"prompt_tokens":7,"completion_tokens":9}}\n\n');
  const cut = 20;
  s.feed(bytes.slice(0, cut));
  s.feed(bytes.slice(cut));
  assert.deepEqual(s.finish(), { pt: 7, ct: 9, exact: true });
});

check("Anthropic 命名也能识别", () => {
  const s = lineScanner();
  s.feed(new TextEncoder().encode('data: {"usage":{"input_tokens":3,"output_tokens":4}}\n\n'));
  assert.deepEqual(s.finish(), { pt: 3, ct: 4, exact: true });
});

check("没有 usage 时标记为不精确", () => {
  const s = lineScanner();
  s.feed(new TextEncoder().encode('data: {"choices":[]}\n\ndata: [DONE]\n\n'));
  assert.deepEqual(s.finish(), { pt: 0, ct: 0, exact: false });
});

// ---------------------------------------------------------------------------
// 5. 会话指纹
// ---------------------------------------------------------------------------

check("同一对话首条消息 → 同一个指纹", () => {
  const bodyA = { messages: [{ role: "user", content: "帮我写个爬虫" }, { role: "assistant", content: "好的" }] };
  const bodyB = {
    messages: [
      { role: "user", content: "帮我写个爬虫" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "再改一下" },
    ],
  };
  assert.equal(sessionHash("k1", bodyA), sessionHash("k1", bodyB));
  assert.notEqual(sessionHash("k1", bodyA), sessionHash("k2", bodyA));
});

check("多模态 content 数组能取到文本", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url" }] }] };
  assert.equal(sessionHash("k1", body).length, 32);
});

const AFP_SAMPLE = {
  ResponseMetadata: { RequestId: "x", Action: "GetAFPUsage", Version: "2024-01-01", Service: "ark" },
  Result: {
    PlanType: "Large",
    AFPFiveHour: { Quota: "50", Used: "12.5", SubscribeTime: 1778788800000, ResetTime: 1778806800000 },
    AFPDaily: { Quota: "100", Used: "22.5", SubscribeTime: 1778716800000, ResetTime: 1778803200000 },
    AFPWeekly: { Quota: "500", Used: "150", SubscribeTime: 1778457600000, ResetTime: 1779062400000 },
    AFPMonthly: { Quota: "2000", Used: "850.5", SubscribeTime: 1777939200000, ResetTime: 1780531200000 },
  },
};

async function withStubbedFetch<T>(
  reply: () => Response,
  fn: (captured: { url: string; headers: Record<string, string> }) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const captured = { url: "", headers: {} as Record<string, string> };
  globalThis.fetch = (async (input: unknown, init: { headers?: Record<string, string> }) => {
    captured.url = String(input);
    captured.headers = init?.headers ?? {};
    return reply();
  }) as typeof fetch;
  try {
    return await fn(captured);
  } finally {
    globalThis.fetch = original;
  }
}

const QUOTA_CFG = {
  provider: "volcengine-afp" as const,
  region: "cn-beijing",
  accessKey: "demo-ak",
  secretKey: "ZGVtb3NlY3JldA==",
  minRemainingPct: 5,
};

await checkAsync("GetAFPUsage 解析四个窗口并取最小剩余比例", async () => {
  const snapshot = await withStubbedFetch(
    () => new Response(JSON.stringify(AFP_SAMPLE), { status: 200 }),
    async (captured) => {
      const result = await fetchVolcengineQuota(QUOTA_CFG);
      // 端点必须是管控面网关，不能是数据面的 volces.com
      assert.equal(captured.url, "https://ark.cn-beijing.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01");
      assert.match(captured.headers.Authorization, /^HMAC-SHA256 Credential=demo-ak\/\d{8}\/cn-beijing\/ark\/request, /);
      return result;
    },
  );

  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.planType, "Large");
  assert.deepEqual(Object.keys(snapshot.windows).sort(), ["daily", "fiveHour", "monthly", "weekly"]);
  // 字符串金额要能转成数字
  assert.equal(snapshot.windows.fiveHour.quota, 50);
  assert.equal(snapshot.windows.monthly.used, 850.5);
  assert.equal(snapshot.windows.weekly.resetTime, 1779062400000);
  // fiveHour 75% / daily 77.5% / weekly 70% / monthly 57.475% → 取最小
  assert.equal(Math.round(snapshot.remainingPct * 1000) / 1000, 57.475);
});

await checkAsync("GetAFPUsage 业务错误不抛异常，落到 error 字段", async () => {
  const snapshot = await withStubbedFetch(
    () =>
      new Response(
        JSON.stringify({
          ResponseMetadata: { Error: { Code: "InvalidAccessKey", Message: "token is invalid" } },
        }),
        { status: 200 },
      ),
    () => fetchVolcengineQuota(QUOTA_CFG),
  );
  assert.match(snapshot.error ?? "", /InvalidAccessKey/);
  assert.equal(snapshot.remainingPct, 0);
});

await checkAsync("缺少 AK/SK 时不发起请求", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const snapshot = await fetchVolcengineQuota({ ...QUOTA_CFG, accessKey: "", secretKey: "" });
    assert.equal(called, false);
    assert.match(snapshot.error ?? "", /AK\/SK/);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// 6. 上游探测的鉴权提示
// ---------------------------------------------------------------------------

const AGENT_PLAN = "https://ark.cn-beijing.volces.com/api/plan/v3";
const CODING_PLAN = "https://ark.cn-beijing.volces.com/api/coding/v3";
const DATA_PLANE = "https://ark.cn-beijing.volces.com/api/v3";

check("套餐 key 打到按量计费入口 → 提示改 /api/plan/v3", () => {
  const hint = authHint(DATA_PLANE, "ark-d6abcdef", 401);
  assert.match(hint, /api\/plan\/v3/);
  assert.match(hint, /套餐 key 在这里无效/);
});

check("套餐 key 用对了入口 → 回退到通用提示", () => {
  const hint = authHint(AGENT_PLAN, "ark-d6abcdef", 401);
  assert.match(hint, /同一个账号和地域/);
});

check("Coding Plan 入口也算套餐入口", () => {
  assert.match(authHint(CODING_PLAN, "ark-d6abcdef", 401), /同一个账号和地域/);
});

check("按量计费 key 打到套餐入口 → 提示 key 类型不对", () => {
  const hint = authHint(AGENT_PLAN, "sk-abcdef", 401);
  assert.match(hint, /只认 Agent Plan/);
});

check("非鉴权错误不给提示", () => {
  assert.equal(authHint(DATA_PLANE, "ark-d6abcdef", 200), "");
  assert.equal(authHint(DATA_PLANE, "ark-d6abcdef", 500), "");
});

check("403 也当鉴权问题处理", () => {
  assert.notEqual(authHint(DATA_PLANE, "ark-d6abcdef", 403), "");
});

// ---------------------------------------------------------------------------
// 7. ListArkAgentPlanModel
// ---------------------------------------------------------------------------

await checkAsync("ListArkAgentPlanModel 解析模型与可用状态", async () => {
  const payload = {
    ResponseMetadata: { RequestId: "x", Action: "ListArkAgentPlanModel", Version: "2024-01-01" },
    Result: {
      Datas: [
        { ModelID: "doubao-seed-2.1-pro", Load: { Status: 1, Level: 2, Score: 2 } },
        { ModelID: "deepseek-v4.1-flash", Load: { Status: 2, Coverage: 0 } },
        { ModelID: "glm-5.3", Load: { Status: 1, Level: 1 } },
        // 没有 Load 的当作可用
        { ModelID: "no-load-model" },
        // 坏数据要跳过而不是崩
        { ModelID: "" },
        "garbage",
      ],
    },
  };

  const result = await withStubbedFetch(
    () => new Response(JSON.stringify(payload), { status: 200 }),
    async (captured) => {
      const r = await listAgentPlanModels({ region: "cn-beijing", accessKey: "demo-ak", secretKey: "ZGVtbw==" });
      assert.match(captured.url, /Action=ListArkAgentPlanModel&Version=2024-01-01/);
      return r;
    },
  );

  assert.equal("error" in result, false);
  const models = (result as { models: { id: string; available: boolean; loadLevel?: number }[] }).models;
  assert.deepEqual(
    models.map((m) => m.id),
    ["doubao-seed-2.1-pro", "deepseek-v4.1-flash", "glm-5.3", "no-load-model"],
  );
  assert.equal(models.find((m) => m.id === "doubao-seed-2.1-pro")?.available, true);
  assert.equal(models.find((m) => m.id === "doubao-seed-2.1-pro")?.loadLevel, 2);
  assert.equal(models.find((m) => m.id === "deepseek-v4.1-flash")?.available, false);
  assert.equal(models.find((m) => m.id === "no-load-model")?.available, true);
});

await checkAsync("ListArkAgentPlanModel 出错时返回 error 而不是抛", async () => {
  const result = await withStubbedFetch(
    () =>
      new Response(
        JSON.stringify({ ResponseMetadata: { Error: { Code: "AccountFlowLimitExceeded", Message: "too fast" } } }),
        { status: 429 },
      ),
    () => listAgentPlanModels({ region: "cn-beijing", accessKey: "AK", secretKey: "SK" }),
  );
  assert.match((result as { error: string }).error, /AccountFlowLimitExceeded/);
});

// ---------------------------------------------------------------------------
// 8. 突发流量排队与斜率保护
// ---------------------------------------------------------------------------

check("normalizeSettings 自动补全 traffic 默认值", () => {
  const cfg = normalizeConfig({});
  assert.equal(cfg.settings.traffic.enabled, true);
  assert.equal(cfg.settings.traffic.burstQueueWaitMs, 3000);
  assert.equal(cfg.settings.traffic.slopeWindowSec, 60);
  assert.equal(cfg.settings.traffic.slopeMaxGrowthRatio, 0.5);
});

check("斜率保护：基线充足时限制超额增速，空窗后重置", () => {
  resetSlopeState("test-slope");
  const traffic = {
    enabled: true,
    burstQueueWaitMs: 0,
    burstQueueMaxSize: 0,
    slopeWindowSec: 60,
    slopeMaxGrowthRatio: 0.5,
    slopeMinBaseline: 10,
  };
  const baseTs = 1_700_000_040_000; // 对齐到某 60s 窗口内
  const w0 = Math.floor(baseTs / 60_000) * 60_000;
  // 第 0 窗口打入 10 次请求建立基线
  for (let i = 0; i < 10; i++) {
    assert.equal(checkSlopeLimit("test-slope", traffic, w0 + i).allowed, true);
  }
  // 第 1 窗口最多允许 ceil(10 * 1.5) = 15 次
  const w1 = w0 + 60_000;
  for (let i = 0; i < 15; i++) {
    assert.equal(checkSlopeLimit("test-slope", traffic, w1 + i).allowed, true);
  }
  const blocked = checkSlopeLimit("test-slope", traffic, w1 + 100);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) {
    assert.equal(blocked.prevCount, 10);
    assert.equal(blocked.maxAllowed, 15);
    assert.ok(blocked.retryAfterSec >= 1);
  }
  // 跳过一个完整空窗到 w3，基线归零不误杀
  const w3 = w0 + 180_000;
  for (let i = 0; i < 20; i++) {
    assert.equal(checkSlopeLimit("test-slope", traffic, w3 + i).allowed, true);
  }
});

await checkAsync("突发排队：上游释放槽位后按模型精准唤醒，超时与队列上限生效", async () => {
  const traffic = {
    enabled: true,
    burstQueueWaitMs: 500,
    burstQueueMaxSize: 1,
    slopeWindowSec: 60,
    slopeMaxGrowthRatio: 0.5,
    slopeMinBaseline: 20,
  };
  const cfg = mkConfig([
    up("q_up_a", { concurrency: 1, models: ["model-a"] }),
    up("q_up_b", { concurrency: 1, models: ["model-b"] }),
  ]);
  const fa = selectAndAcquire(cfg, "model-a", "");
  const fb = selectAndAcquire(cfg, "model-b", "");
  assert.equal(fa.up?.id, "q_up_a");
  assert.equal(fb.up?.id, "q_up_b");

  const waitA1 = waitForUpstreamSlot("model-a", traffic);
  const waitA2 = waitForUpstreamSlot("model-a", traffic); // 同模型超出 maxSize=1 被拒绝
  const waitB1 = waitForUpstreamSlot("model-b", traffic); // 不同模型独立队列不受影响

  assert.equal(await waitA2, false);
  // 释放 q_up_b 不会错误唤醒 model-a，而是唤醒 model-b
  releaseUpstream("q_up_b");
  assert.equal(await waitB1, true);
  releaseUpstream("q_up_a");
  assert.equal(await waitA1, true);

  const shortWait = await waitForUpstreamSlot("model-a", { ...traffic, burstQueueWaitMs: 30 });
  assert.equal(shortWait, false);
});

check("斜率保护按「上游 × 模型」隔离，超限后自动切到备用上游", () => {
  resetSlopeState();
  const traffic = {
    enabled: true,
    burstQueueWaitMs: 0,
    burstQueueMaxSize: 0,
    slopeWindowSec: 60,
    slopeMaxGrowthRatio: 0.5,
    slopeMinBaseline: 10,
  };
  const cfg = mkConfig([up("sl_a", { priority: 1 }), up("sl_b", { priority: 50 })], {
    traffic,
    weights: { topK: 1 },
  });
  const w0 = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
  const w1 = w0 + 60_000;

  // 只把 sl_a + model-x 在上个窗口打满基线 10，且当前窗口打满上限 15
  for (let i = 0; i < 10; i++) {
    assert.equal(checkSlopeLimit(slopeScope("sl_a", "model-x"), traffic, w0 + i).allowed, true);
  }
  for (let i = 0; i < 15; i++) {
    assert.equal(checkSlopeLimit(slopeScope("sl_a", "model-x"), traffic, w1 + i).allowed, true);
  }

  // sl_a 的 model-x 超斜率，应自动分流到 sl_b
  const pickedX = selectAndAcquire(cfg, "model-x", "", new Set(), w1 + 100);
  assert.equal(pickedX.up?.id, "sl_b");
  if (pickedX.up) releaseUpstream(pickedX.up.id);

  // sl_a 的 model-y 不受影响，仍优先选中 sl_a
  const pickedY = selectAndAcquire(cfg, "model-y", "", new Set(), w1 + 100);
  assert.equal(pickedY.up?.id, "sl_a");
  if (pickedY.up) releaseUpstream(pickedY.up.id);

  // 如果排除 sl_b，全部上游都触及斜率上限，返回 all_slope_limited
  const blocked = selectAndAcquire(cfg, "model-x", "", new Set(["sl_b"]), w1 + 100);
  assert.equal(blocked.up, null);
  assert.equal(blocked.reason, "all_slope_limited");
  if (!blocked.up) assert.ok((blocked.retryAfterSec ?? 0) >= 1);
});

// ---------------------------------------------------------------------------
// 9. 模型定价、缓存命中提取与费用计算
// ---------------------------------------------------------------------------

check("usage 提取 cached_tokens 与 cache_read_input_tokens", () => {
  const s1 = lineScanner();
  s1.feed(
    new TextEncoder().encode(
      'data: {"usage":{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":600}}}\n\n',
    ),
  );
  assert.deepEqual(s1.finish(), { pt: 1000, ct: 200, cachedPt: 600, exact: true });

  const s2 = lineScanner();
  s2.feed(
    new TextEncoder().encode(
      'data: {"usage":{"input_tokens":500,"output_tokens":100,"cache_read_input_tokens":300}}\n\n',
    ),
  );
  assert.deepEqual(s2.finish(), { pt: 500, ct: 100, cachedPt: 300, exact: true });
});

check("normalizeModelPrices 与 calculateModelCost 精确扣减缓存命中", () => {
  const cfg = normalizeConfig({
    modelPrices: {
      "doubao-seed-2.1-lite": { inputPerM: 0.8, cachedInputPerM: 0.16, outputPerM: 2.7 },
    },
  });
  const pricing = cfg.modelPrices["doubao-seed-2.1-lite"];
  assert.ok(pricing);
  // 1M 总输入（含 500k 缓存命中 => 500k 常规输入 * 0.8 + 500k 缓存 * 0.16 = 0.4 + 0.08 = 0.48）+ 1M 输出 * 2.7 = 3.18
  const cost = calculateModelCost(1_000_000, 1_000_000, 500_000, pricing);
  assert.ok(Math.abs(cost - 3.18) < 1e-9);
  assert.equal(calculateModelCost(1000, 1000, 0, null), 0);
  assert.equal(formatCost(0.00123), "¥0.0012");
  assert.equal(formatCost(3.18), "¥3.18");
});

// ---------------------------------------------------------------------------
// 10. 正文捕获、脱敏截断与 MySQL ID 生成
// ---------------------------------------------------------------------------

check("normalizeSettings 自动补全并校验 trace 配置", () => {
  const def = normalizeConfig({}).settings.trace;
  assert.equal(def.enabled, true);
  assert.equal(def.maxBodyKb, 128);
  assert.equal(def.redactBase64, false);
  const clamped = normalizeConfig({
    settings: { trace: { enabled: false, maxBodyKb: 99999, redactBase64: true } },
  }).settings.trace;
  assert.equal(clamped.enabled, false);
  assert.equal(clamped.maxBodyKb, 16384);
  assert.equal(clamped.redactBase64, true);
});

check("prepareTraceBody 按开关脱敏 Base64 并按 UTF-8 字节截断", () => {
  const b64 = "A".repeat(300);
  const raw = JSON.stringify({ url: `data:image/png;base64,${b64}`, text: "你好世界abcdef" });

  // 默认关闭脱敏：保留原始 Base64
  const kept = prepareTraceBody(raw, 1024);
  assert.equal(kept.truncated, false);
  assert.equal(kept.text.includes(b64), true);

  // 开启脱敏：替换为占位符
  const sanitized = prepareTraceBody(raw, 1024, true);
  assert.equal(sanitized.truncated, false);
  assert.match(sanitized.text, /\[base64 omitted: \d+ chars\]/);
  assert.equal(sanitized.text.includes(b64), false);

  const cut = prepareTraceBody("你好世界123456", 7);
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.text, "utf8") <= 7);
});

check("lineScanner 流式正文合并（content/reasoning/tool_calls）与截断", () => {
  const s = lineScanner(1024);
  const enc = new TextEncoder();
  s.feed(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"先思"}}]}\n\n'));
  s.feed(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"考一下"}}]}\n\n'));
  s.feed(enc.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'));
  s.feed(enc.encode('data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n'));
  s.feed(
    enc.encode(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
    ),
  );
  s.feed(
    enc.encode(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Beijing\\"}"}}]}}]}\n\n',
    ),
  );
  s.feed(enc.encode('data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n'));
  assert.deepEqual(s.finish(), { pt: 10, ct: 20, exact: true });
  assert.deepEqual(s.captured, {
    content: "你好，世界",
    reasoning: "先思考一下",
    toolCalls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Beijing"}' } }],
    truncated: false,
  });

  const small = lineScanner(6);
  small.feed(enc.encode('data: {"choices":[{"delta":{"content":"1234"}}]}\n\n'));
  small.feed(enc.encode('data: {"choices":[{"delta":{"content":"5678"}}]}\n\n'));
  small.feed(enc.encode('data: {"usage":{"prompt_tokens":5,"completion_tokens":8}}\n\n'));
  assert.deepEqual(small.finish(), { pt: 5, ct: 8, exact: true });
  assert.equal(small.captured?.content, "123456");
  assert.equal(small.captured?.truncated, true);
});

check("generateLogId 生成 26 位按时间单调有序 ID", () => {
  const a = generateLogId(1_700_000_000_000);
  const b = generateLogId(1_700_000_001_000);
  assert.equal(a.length, 26);
  assert.equal(b.length, 26);
  assert.ok(a.slice(0, 12) < b.slice(0, 12));
});

check("canonicalModelName 与 findModelPricing 归并 -六位数字 后缀", () => {
  assert.equal(canonicalModelName("doubao-seed-2-1-lite-260915"), "doubao-seed-2-1-lite");
  assert.equal(canonicalModelName("doubao-seed-2.1-lite"), "doubao-seed-2.1-lite");
  assert.equal(canonicalModelName("glm-5.3"), "glm-5.3");

  const cfg = normalizeConfig({
    modelPrices: {
      "doubao-seed-2-1-lite-260915": { inputPerM: 1, cachedInputPerM: 0.2, outputPerM: 3 },
      "doubao-seed-2-1-lite": { inputPerM: 0.8, cachedInputPerM: 0.16, outputPerM: 2.7 },
    },
  });
  // 优先保留精确前缀定价
  assert.deepEqual(Object.keys(cfg.modelPrices), ["doubao-seed-2-1-lite"]);
  assert.equal(findModelPricing(cfg.modelPrices, "doubao-seed-2-1-lite-260915")?.inputPerM, 0.8);
  assert.equal(findModelPricing(cfg.modelPrices, "doubao-seed-2-1-lite")?.outputPerM, 2.7);
});

check("mergeBuckets 正确累加用量与缓存命中", () => {
  const merged = mergeBuckets(
    { req: 2, err: 0, pt: 100, ct: 50, cachedPt: 40, ttftSum: 200, ttftN: 2, msSum: 500 },
    { req: 3, err: 1, pt: 300, ct: 150, ttftSum: 300, ttftN: 1, msSum: 700 },
  );
  assert.deepEqual(merged, {
    req: 5,
    err: 1,
    pt: 400,
    ct: 200,
    cachedPt: 40,
    ttftSum: 500,
    ttftN: 3,
    msSum: 1200,
  });
});

// ---------------------------------------------------------------------------
// 11. 低优模式（Flex）配置校验、时间窗与自动回退重试
// ---------------------------------------------------------------------------

check("normalizeSettings 补全并校验 flex 配置", () => {
  const def = normalizeConfig({}).settings.flex;
  assert.equal(def.enabled, false);
  assert.equal(def.startTime, "00:00");
  assert.equal(def.endTime, "08:00");
  assert.equal(def.maxWaitTimeoutMs, 60_000);
  assert.equal(def.fallbackToDefault, true);

  const clamped = normalizeConfig({
    settings: {
      flex: {
        enabled: true,
        startTime: "22:30",
        endTime: "07:00",
        maxWaitTimeoutMs: 9_999_999,
        fallbackToDefault: false,
      },
    },
  }).settings.flex;
  assert.equal(clamped.enabled, true);
  assert.equal(clamped.startTime, "22:30");
  assert.equal(clamped.endTime, "07:00");
  assert.equal(clamped.maxWaitTimeoutMs, 1_200_000);
  assert.equal(clamped.fallbackToDefault, false);

  assert.throws(() => normalizeConfig({ settings: { flex: { startTime: "25:00" } } }));
  assert.throws(() => normalizeConfig({ settings: { flex: { endTime: "abc" } } }));
});

check("normalizeUpstream 仅允许按量付费上游开启 flexEnabled", () => {
  const cfg = normalizeConfig({
    upstreams: [
      up("payg", { flexEnabled: true, quota: null }),
      up("plan", {
        flexEnabled: true,
        quota: { provider: "volcengine-afp", accessKey: "a", secretKey: "b", minRemainingPct: 5 },
      }),
    ],
  });
  assert.equal(cfg.upstreams[0].flexEnabled, true);
  assert.equal(cfg.upstreams[1].flexEnabled, false);
});

check("isFlexWindowActive 覆盖关闭、日间、跨午夜与全天", () => {
  const at = (h: number, m: number) => {
    const d = new Date(2026, 10, 26, h, m, 0, 0);
    return d.getTime();
  };
  assert.equal(
    isFlexWindowActive({ enabled: false, startTime: "00:00", endTime: "23:59", maxWaitTimeoutMs: 0, fallbackToDefault: true }, at(12, 0)),
    false,
  );
  // 日间窗口 09:00 ~ 18:00
  const day = { enabled: true, startTime: "09:00", endTime: "18:00", maxWaitTimeoutMs: 0, fallbackToDefault: true };
  assert.equal(isFlexWindowActive(day, at(8, 59)), false);
  assert.equal(isFlexWindowActive(day, at(9, 0)), true);
  assert.equal(isFlexWindowActive(day, at(17, 59)), true);
  assert.equal(isFlexWindowActive(day, at(18, 0)), false);

  // 跨午夜 22:00 ~ 08:00
  const night = { enabled: true, startTime: "22:00", endTime: "08:00", maxWaitTimeoutMs: 0, fallbackToDefault: true };
  assert.equal(isFlexWindowActive(night, at(21, 59)), false);
  assert.equal(isFlexWindowActive(night, at(22, 0)), true);
  assert.equal(isFlexWindowActive(night, at(2, 30)), true);
  assert.equal(isFlexWindowActive(night, at(7, 59)), true);
  assert.equal(isFlexWindowActive(night, at(8, 0)), false);

  // 全天（起止相同或留空）
  assert.equal(
    isFlexWindowActive({ enabled: true, startTime: "00:00", endTime: "00:00", maxWaitTimeoutMs: 0, fallbackToDefault: true }, at(15, 0)),
    true,
  );
  assert.equal(
    isFlexWindowActive({ enabled: true, startTime: "", endTime: "", maxWaitTimeoutMs: 0, fallbackToDefault: true }, at(15, 0)),
    true,
  );
});

check("shouldFallbackFromFlex 准确识别可回退状态码", () => {
  assert.equal(shouldFallbackFromFlex(429, "ServerOverloaded"), true);
  assert.equal(shouldFallbackFromFlex(408, "timeout"), true);
  assert.equal(shouldFallbackFromFlex(503, "overload"), true);
  assert.equal(shouldFallbackFromFlex(500, ""), true);
  assert.equal(shouldFallbackFromFlex(400, "InvalidParameter.UnsupportedParameter: service_tier"), true);
  assert.equal(shouldFallbackFromFlex(401, "invalid key"), false);
  assert.equal(shouldFallbackFromFlex(403, "forbidden"), false);
  assert.equal(shouldFallbackFromFlex(404, "not found"), false);
  assert.equal(shouldFallbackFromFlex(400, "missing messages"), false);
});

await checkAsync("handleProxy 自动注入 Flex 并在 429/408 时同上游回退重试一次", async () => {
  const gStore = globalThis as unknown as { __aiProxyStore?: { config: unknown } };
  const storeObj = gStore.__aiProxyStore;
  assert.ok(storeObj);
  const prevConfig = storeObj.config;
  const prevFetch = globalThis.fetch;

  const testCfg = normalizeConfig({
    settings: {
      maxAttempts: 2,
      trace: { enabled: false, maxBodyKb: 128, redactBase64: false },
      flex: {
        enabled: true,
        startTime: "00:00",
        endTime: "00:00", // 全天生效
        maxWaitTimeoutMs: 45_000,
        fallbackToDefault: true,
      },
    },
    upstreams: [
      up("flex_payg", { flexEnabled: true, quota: null, concurrency: 10 }),
    ],
    keys: [
      { id: "k_flex", name: "flex-test", key: "sk-flex-test", enabled: true },
    ],
  });

  storeObj.config = testCfg;

  try {
    const calls: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    let mode: "ok" | "429_then_ok" | "408_then_ok" = "ok";

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const headersObj: Record<string, string> = {};
      h.forEach((v, k) => {
        headersObj[k.toLowerCase()] = v;
      });
      const bodyObj = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ headers: headersObj, body: bodyObj });

      if (mode === "429_then_ok" && calls.length === 1) {
        return new Response('{"error":{"code":"ServerOverloaded"}}', { status: 429 });
      }
      if (mode === "408_then_ok" && calls.length === 1) {
        return new Response('{"error":{"message":"wait timeout"}}', { status: 408 });
      }
      return Response.json({
        id: "resp_1",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ message: { role: "assistant", content: "ok" } }],
      });
    }) as typeof fetch;

    const mkReq = (extraBody: Record<string, unknown> = {}) =>
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-flex-test" },
        body: JSON.stringify({ model: "doubao-seed-2-1-lite-260915", messages: [{ role: "user", content: "hi" }], ...extraBody }),
      });

    // 1. 正常命中 Flex
    mode = "ok";
    calls.length = 0;
    const res1 = await handleProxy(mkReq(), { path: "/chat/completions" });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get("x-ai-proxy-service-tier"), "flex");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.service_tier, "flex");
    assert.equal(calls[0].headers["x-ark-max-wait-timeout-ms"], "45000");

    // 2. Flex 返回 429 → 同上游去掉 service_tier 和等待头重试一次，且不触发冷却
    mode = "429_then_ok";
    calls.length = 0;
    const res2 = await handleProxy(mkReq(), { path: "/chat/completions" });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get("x-ai-proxy-service-tier"), "default-fallback");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.service_tier, "flex");
    assert.equal(calls[0].headers["x-ark-max-wait-timeout-ms"], "45000");
    assert.equal("service_tier" in calls[1].body, false);
    assert.equal(calls[1].headers["x-ark-max-wait-timeout-ms"], undefined);
    assert.equal(upState("flex_payg").cooldownUntil, 0);

    // 3. Flex 返回 408 → 同上游回退重试一次成功
    mode = "408_then_ok";
    calls.length = 0;
    const res3 = await handleProxy(mkReq(), { path: "/chat/completions" });
    assert.equal(res3.status, 200);
    assert.equal(res3.headers.get("x-ai-proxy-service-tier"), "default-fallback");
    assert.equal(calls.length, 2);
    assert.equal("service_tier" in calls[1].body, false);

    // 4. 客户端显式传入 service_tier: "default" 时不覆盖
    mode = "ok";
    calls.length = 0;
    const res4 = await handleProxy(mkReq({ service_tier: "default" }), { path: "/chat/completions" });
    assert.equal(res4.status, 200);
    assert.equal(res4.headers.get("x-ai-proxy-service-tier"), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.service_tier, "default");
    assert.equal(calls[0].headers["x-ark-max-wait-timeout-ms"], undefined);
  } finally {
    globalThis.fetch = prevFetch;
    storeObj.config = prevConfig;
  }
});

console.log(`\n${passed} 项通过${process.exitCode ? "，有失败" : ""}`);