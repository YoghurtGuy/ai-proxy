"use client";

import { useEffect } from "react";
import { Activity, AlertTriangle, Coins, Timer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrafficChart, type TrafficPoint } from "@/components/traffic-chart";
import { useResource, useNow } from "@/lib/client";
import { countdown, errorRate, formatMs, formatNumber } from "@/lib/format";

interface Summary {
  req: number;
  err: number;
  pt: number;
  ct: number;
  tokens: number;
  avgTtftMs: number;
  avgMs: number;
}

interface QuotaWindow {
  quota: number;
  used: number;
  resetTime: number;
}

interface QuotaSnapshot {
  planType?: string;
  remainingPct: number;
  windows: Record<string, QuotaWindow>;
  fetchedAt: number;
  error?: string;
}

interface UpstreamRuntime {
  inflight: number;
  cooldownUntil: number;
  cooldownReason: string;
  errEwma: number;
  successTotal: number;
  failTotal: number;
  lastStatus: number;
  lastLatencyMs: number;
  quota: QuotaSnapshot | null;
}

interface UpstreamRow {
  id: string;
  name: string;
  enabled: boolean;
  models: string[];
  priority: number;
  concurrency: number;
  hasQuota: boolean;
  today: Summary;
  runtime: UpstreamRuntime;
}

interface KeyRow {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  today: Summary;
  inflight: number;
}

interface Overview {
  totals: Summary;
  series: TrafficPoint[];
  upstreams: UpstreamRow[];
  keys: KeyRow[];
  models: ({ model: string } & Summary)[];
  dataDir: string;
}

function StatCard({
  title,
  value,
  hint,
  icon: Icon,
}: {
  title: string;
  value: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{title}</span>
          <span className="font-heading text-2xl font-semibold tabular-nums">{value}</span>
          {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
        <Icon className="mt-1 size-4 text-muted-foreground" />
      </CardContent>
    </Card>
  );
}

function UpstreamStatus({ row, now }: { row: UpstreamRow; now: number }) {
  if (!row.enabled) return <Badge variant="secondary">已停用</Badge>;
  if (row.runtime.quota?.error) return <Badge variant="destructive">额度异常</Badge>;
  if (row.runtime.cooldownUntil > now) {
    return <Badge variant="destructive">冷却 {countdown(row.runtime.cooldownUntil, now)}</Badge>;
  }
  if (row.runtime.quota && row.runtime.quota.remainingPct < 5) return <Badge variant="destructive">额度不足</Badge>;
  if (row.runtime.errEwma > 0.5) return <Badge variant="secondary">错误率高</Badge>;
  return <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">正常</Badge>;
}

function QuotaBar({ quota }: { quota: QuotaSnapshot | null }) {
  if (!quota) return <span className="text-xs text-muted-foreground">按量计费</span>;
  if (quota.error) {
    return (
      <span className="text-xs text-destructive" title={quota.error}>
        获取失败
      </span>
    );
  }
  const pct = Math.max(0, Math.min(100, quota.remainingPct));
  const tone = pct < 10 ? "bg-destructive" : pct < 30 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex w-32 flex-col gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">剩余 {pct.toFixed(1)}%</span>
    </div>
  );
}

export default function DashboardPage() {
  const { data, error, reload } = useResource<Overview>("/api/admin/overview");
  const now = useNow();

  useEffect(() => {
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, [reload]);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>加载失败</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const totals = data?.totals;
  const errRate = totals ? errorRate(totals.err, totals.req) : null;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-heading text-xl font-semibold">仪表盘</h1>
        <p className="text-sm text-muted-foreground">
          今日用量与上游健康度，每 15 秒自动刷新{data ? ` · 数据目录 ${data.dataDir}` : ""}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="今日请求" value={formatNumber(totals?.req ?? 0)} icon={Activity} />
        <StatCard
          title="今日 Token"
          value={formatNumber(totals?.tokens ?? 0)}
          hint={totals ? `输入 ${formatNumber(totals.pt)} / 输出 ${formatNumber(totals.ct)}` : undefined}
          icon={Coins}
        />
        <StatCard
          title="错误率"
          value={errRate ?? "—"}
          hint={totals ? `${formatNumber(totals.err)} 次错误` : undefined}
          icon={AlertTriangle}
        />
        <StatCard
          title="平均首字延迟"
          value={formatMs(totals?.avgTtftMs ?? 0)}
          hint={totals ? `平均总耗时 ${formatMs(totals.avgMs)}` : undefined}
          icon={Timer}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>流量</CardTitle>
          <CardDescription>红色表示该分钟内有失败请求</CardDescription>
        </CardHeader>
        <CardContent>{data ? <TrafficChart series={data.series} /> : null}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>上游</CardTitle>
          <CardDescription>负载、额度与冷却状态</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">名称</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>并发</TableHead>
                <TableHead>额度</TableHead>
                <TableHead className="text-right">今日请求</TableHead>
                <TableHead className="text-right">错误率</TableHead>
                <TableHead className="pr-4 text-right">延迟</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.upstreams ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                    还没有上游，去「上游」页添加一个
                  </TableCell>
                </TableRow>
              ) : (
                data?.upstreams.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="pl-4">
                      <div className="flex flex-col">
                        <span className="font-medium">{row.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {row.models.includes("*") ? "全部模型" : `${row.models.length} 个模型`} · 优先级 {row.priority}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <UpstreamStatus row={row} now={now} />
                    </TableCell>
                    <TableCell className="tabular-nums text-sm">
                      {row.runtime.inflight}/{row.concurrency}
                    </TableCell>
                    <TableCell>
                      <QuotaBar quota={row.runtime.quota} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.today.req)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {errorRate(row.today.err, row.today.req) ?? "—"}
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">{formatMs(row.runtime.lastLatencyMs)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>下游 Key</CardTitle>
            <CardDescription>今日用量</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">名称</TableHead>
                  <TableHead className="text-right">请求</TableHead>
                  <TableHead className="pr-4 text-right">Token</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.keys ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">
                      还没有下游 key
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.keys.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="pl-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{row.name}</span>
                          {!row.enabled ? <Badge variant="secondary">停用</Badge> : null}
                          {row.inflight > 0 ? <Badge variant="outline">进行中 {row.inflight}</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.today.req)}</TableCell>
                      <TableCell className="pr-4 text-right tabular-nums">{formatNumber(row.today.tokens)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>模型用量</CardTitle>
            <CardDescription>今日按模型拆分</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">模型</TableHead>
                  <TableHead className="text-right">请求</TableHead>
                  <TableHead className="pr-4 text-right">Token</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.models ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">
                      今天还没有流量
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.models.map((row) => (
                    <TableRow key={row.model}>
                      <TableCell className="pl-4 font-mono text-xs">{row.model}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.req)}</TableCell>
                      <TableCell className="pr-4 text-right tabular-nums">{formatNumber(row.tokens)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}