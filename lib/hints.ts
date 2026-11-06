/**
 * 上游探测失败时，把「大概率填错了什么」翻译成一句能照着改的提示。
 *
 * 火山方舟的 key 前缀和入口是绑定的，填错入口是最常见的 401 原因：
 *   sk-…  → 按量计费   /api/v3
 *   ark-… → 套餐专属   /api/plan/v3（Agent Plan）或 /api/coding/v3（Coding Plan）
 */
export function authHint(baseUrl: string, apiKey: string, status: number): string {
  if (status !== 401 && status !== 403) return "";

  const key = apiKey.trim();
  const base = baseUrl.replace(/\/+$/, "");
  const isPlanKey = key.startsWith("ark-");
  const atPlan = /\/api\/plan\/v3$/.test(base);
  const atCoding = /\/api\/coding\/v3$/.test(base);
  const atDataPlane = /\/api\/v3$/.test(base);

  if (isPlanKey && atDataPlane) {
    return "ark- 开头的是套餐专属 key：Agent Plan 要用 https://ark.cn-beijing.volces.com/api/plan/v3，Coding Plan 用 /api/coding/v3。/api/v3 是按量计费入口，套餐 key 在这里无效。";
  }
  if (isPlanKey && !atPlan && !atCoding) {
    return "ark- 开头的套餐 key 只能用在 /api/plan/v3（Agent Plan）或 /api/coding/v3（Coding Plan）。";
  }
  if (!isPlanKey && (atPlan || atCoding)) {
    return "套餐专属入口只认 Agent Plan / Coding Plan 的 ark- 开头 key，sk- 开头的按量计费 key 用不了。";
  }
  return "key 被上游拒绝：确认未过期、未删除，且与该 Base URL 属于同一个账号和地域。";
}