export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
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