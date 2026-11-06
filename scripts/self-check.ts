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
import { lineScanner } from "../lib/stream";
import { parseCooldownMs, sessionHash } from "../lib/forward";
import { markCooldown, releaseUpstream, selectAndAcquire, upState } from "../lib/scheduler";
import { normalizeConfig } from "../lib/types";
import { signRequest } from "../lib/quota/volcengine";

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

// ---------------------------------------------------------------------------
// 1. Signature V4 —— 用例和期望值直接来自火山引擎《签名方法》文档
// ---------------------------------------------------------------------------

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

console.log(`\n${passed} 项通过${process.exitCode ? "，有失败" : ""}`);