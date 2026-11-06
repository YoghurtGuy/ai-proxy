export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** AFP 额度可能是小数，保留小数以免把 850.5 显示成 851。 */
export function formatAfp(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (!Number.isInteger(n) && Math.abs(n) < 10_000) return n.toFixed(1);
  return formatNumber(n);
}

/** 额度重置时间：比别人要等的“距离刷新还多久”更粗一点。 */
export function formatReset(ts: number, now: number): string {
  if (!ts) return "—";
  const ms = ts - now;
  if (ms <= 0) return "即将重置";
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 60) return `${totalMin} 分后`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins ? `${hours} 小时 ${mins} 分后` : `${hours} 小时后`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时后` : `${days} 天后`;
}

export function formatMs(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

/** 错误率百分比，请求数为 0 时返回 null 让调用方显示占位。 */
export function errorRate(err: number, req: number): string | null {
  if (!req) return null;
  return `${((err / req) * 100).toFixed(1)}%`;
}

export function formatTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 剩余冷却时间的人类可读形式。now 必须由调用方传入，避免在渲染期读时间。 */
export function countdown(until: number, now: number): string {
  const ms = until - now;
  if (ms <= 0) return "";
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.ceil(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.ceil(mins / 60)}h`;
}

export function maskKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}