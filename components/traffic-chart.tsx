"use client";

import { cn } from "cn";
import { formatClock } from "@/lib/format";

export interface TrafficPoint {
  minute: number;
  req: number;
  err: number;
  pt: number;
  ct: number;
}

/** 手写柱状图，不为了一个 60 柱的图引 recharts。 */
export function TrafficChart({ series }: { series: TrafficPoint[] }) {
  const max = Math.max(1, ...series.map((p) => p.req));
  const total = series.reduce((sum, p) => sum + p.req, 0);
  const first = series[0]?.minute;
  const last = series[series.length - 1]?.minute;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-32 items-end gap-[2px]">
        {series.map((point) => {
          const height = (point.req / max) * 100;
          return (
            <div
              key={point.minute}
              className={cn(
                "flex-1 rounded-t-sm transition-colors",
                point.err > 0 ? "bg-destructive/70" : "bg-primary/70",
                point.req === 0 && "bg-muted",
              )}
              style={{ height: `${Math.max(height, point.req > 0 ? 4 : 1)}%` }}
              title={`${formatClock(point.minute * 60_000)} · ${point.req} 请求 · ${point.err} 错误`}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{first ? formatClock(first * 60_000) : ""}</span>
        <span>最近 60 分钟 · 共 {total} 请求</span>
        <span>{last ? formatClock(last * 60_000) : ""}</span>
      </div>
    </div>
  );
}