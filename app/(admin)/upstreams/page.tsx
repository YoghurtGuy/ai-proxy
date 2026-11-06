"use client";

import { useState } from "react";
import { CheckCircle2, Eraser, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { apiSend, useNow, useResource } from "@/lib/client";
import { countdown, formatMs, formatNumber } from "@/lib/format";
import type { QuotaSnapshot, Upstream } from "@/lib/types";

interface UpstreamRow extends Upstream {
  runtime: {
    inflight: number;
    cooldownUntil: number;
    cooldownReason: string;
    successTotal: number;
    failTotal: number;
    lastLatencyMs: number;
    quota: QuotaSnapshot | null;
  } | null;
}

interface FormState {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelsText: string;
  priority: string;
  concurrency: string;
  enabled: boolean;
  quotaEnabled: boolean;
  region: string;
  accessKey: string;
  secretKey: string;
  minRemainingPct: string;
}

const EMPTY_FORM: FormState = {
  id: "",
  name: "",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  apiKey: "",
  modelsText: "*",
  priority: "50",
  concurrency: "8",
  enabled: true,
  quotaEnabled: false,
  region: "cn-beijing",
  accessKey: "",
  secretKey: "",
  minRemainingPct: "5",
};

function toForm(up: UpstreamRow): FormState {
  return {
    id: up.id,
    name: up.name,
    baseUrl: up.baseUrl,
    apiKey: up.apiKey,
    modelsText: up.models.join(", "),
    priority: String(up.priority),
    concurrency: String(up.concurrency),
    enabled: up.enabled,
    quotaEnabled: Boolean(up.quota),
    region: up.quota?.region ?? "cn-beijing",
    accessKey: up.quota?.accessKey ?? "",
    secretKey: up.quota?.secretKey ?? "",
    minRemainingPct: String(up.quota?.minRemainingPct ?? 5),
  };
}

function payloadOf(form: FormState) {
  const models = form.modelsText
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    models: models.length ? models : ["*"],
    priority: Number(form.priority) || 50,
    concurrency: Number(form.concurrency) || 8,
    enabled: form.enabled,
    quota: form.quotaEnabled
      ? {
          provider: "volcengine-afp",
          region: form.region.trim() || "cn-beijing",
          accessKey: form.accessKey.trim(),
          secretKey: form.secretKey.trim(),
          minRemainingPct: Number(form.minRemainingPct) || 0,
        }
      : null,
  };
}

export default function UpstreamsPage() {
  const { data, error, reload } = useResource<{ upstreams: UpstreamRow[] }>("/api/admin/upstreams");
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setOpen(true);
  };

  const openEdit = (up: UpstreamRow) => {
    setForm(toForm(up));
    setOpen(true);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (form.id) {
        await apiSend("/api/admin/upstreams", "PUT", { ...payloadOf(form), id: form.id });
        toast.success("已保存");
      } else {
        await apiSend("/api/admin/upstreams", "POST", payloadOf(form));
        toast.success("已添加上游");
      }
      setOpen(false);
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (up: UpstreamRow) => {
    if (!confirm(`确定删除上游「${up.name}」？`)) return;
    try {
      await apiSend(`/api/admin/upstreams?id=${encodeURIComponent(up.id)}`, "DELETE");
      toast.success("已删除");
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const test = async (up: UpstreamRow) => {
    const id = toast.loading(`正在测试 ${up.name}…`);
    try {
      const res = await apiSend<{ result: { ok: boolean; status: number; ms: number; detail: string; sample: string[] } }>(
        "/api/admin/actions",
        "POST",
        { action: "testUpstream", id: up.id },
      );
      const r = res.result;
      toast[r.ok ? "success" : "error"](
        r.ok ? `${up.name} 连通，${r.ms}ms，${r.sample.length} 个模型` : `${up.name} 失败：HTTP ${r.status} ${r.detail}`,
        { id },
      );
    } catch (err) {
      toast.error((err as Error).message, { id });
    }
  };

  const refreshQuota = async (up: UpstreamRow) => {
    try {
      const res = await apiSend<{ quota: QuotaSnapshot }>("/api/admin/upstreams", "PATCH", { id: up.id });
      if (res.quota.error) toast.error(`额度获取失败：${res.quota.error}`);
      else toast.success(`剩余额度 ${res.quota.remainingPct.toFixed(1)}%`);
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const clearCooldown = async (up: UpstreamRow) => {
    try {
      await apiSend("/api/admin/upstreams", "PATCH", { id: up.id, action: "clearCooldown" });
      toast.success("已清除冷却");
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold">上游</h1>
          <p className="text-sm text-muted-foreground">
            套餐额度类上游（Agent Plan）需要 IAM AK/SK 才能查额度；按量计费上游不填额度即可，不参与额度调度。
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          添加上游
        </Button>
      </div>

      {error ? (
        <Card>
          <CardHeader>
            <CardTitle>加载失败</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">名称</TableHead>
                <TableHead>地址</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>优先级 / 并发</TableHead>
                <TableHead>额度</TableHead>
                <TableHead className="pr-4 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.upstreams ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    还没有上游
                  </TableCell>
                </TableRow>
              ) : (
                data?.upstreams.map((up) => {
                  const cooling = up.runtime && up.runtime.cooldownUntil > now;
                  return (
                    <TableRow key={up.id}>
                      <TableCell className="pl-4">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{up.name}</span>
                            {!up.enabled ? <Badge variant="secondary">停用</Badge> : null}
                            {cooling ? (
                              <Badge variant="destructive">
                                冷却 {countdown(up.runtime!.cooldownUntil, now)}
                              </Badge>
                            ) : null}
                          </div>
                          <span className="font-mono text-xs text-muted-foreground">
                            成功率{" "}
                            {up.runtime && up.runtime.successTotal + up.runtime.failTotal > 0
                              ? `${Math.round(
                                  (up.runtime.successTotal / (up.runtime.successTotal + up.runtime.failTotal)) * 100,
                                )}%`
                              : "—"}
                            {up.runtime?.lastLatencyMs ? ` · ${formatMs(up.runtime.lastLatencyMs)}` : ""}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[240px] truncate font-mono text-xs">{up.baseUrl}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {up.models.includes("*") ? "全部" : up.models.join(", ")}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {up.priority} / {up.concurrency}
                        {up.runtime ? <span className="text-muted-foreground"> · 在用 {up.runtime.inflight}</span> : null}
                      </TableCell>
                      <TableCell className="text-xs">
                        {up.quota ? (
                          up.runtime?.quota?.error ? (
                            <span className="text-destructive">获取失败</span>
                          ) : up.runtime?.quota ? (
                            <span className="tabular-nums">{up.runtime.quota.remainingPct.toFixed(1)}% 剩余</span>
                          ) : (
                            <span className="text-muted-foreground">待拉取</span>
                          )
                        ) : (
                          <span className="text-muted-foreground">按量计费</span>
                        )}
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon-sm" title="测试连通性" onClick={() => test(up)}>
                            <CheckCircle2 className="size-3.5" />
                          </Button>
                          {up.quota ? (
                            <Button variant="ghost" size="icon-sm" title="刷新额度" onClick={() => refreshQuota(up)}>
                              <RefreshCw className="size-3.5" />
                            </Button>
                          ) : null}
                          {cooling ? (
                            <Button variant="ghost" size="icon-sm" title="清除冷却" onClick={() => clearCooldown(up)}>
                              <Eraser className="size-3.5" />
                            </Button>
                          ) : null}
                          <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => openEdit(up)}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon-sm" title="删除" onClick={() => remove(up)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        今日请求数见仪表盘 · 共 {formatNumber(data?.upstreams.length ?? 0)} 个上游
      </p>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{form.id ? "编辑上游" : "添加上游"}</DialogTitle>
              <DialogDescription>填 OpenAI 兼容的 Base URL，不含 /chat/completions</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="up-name">名称</Label>
              <Input id="up-name" value={form.name} onChange={(e) => set("name", e.target.value)} required />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="up-url">Base URL</Label>
              <Input
                id="up-url"
                value={form.baseUrl}
                onChange={(e) => set("baseUrl", e.target.value)}
                placeholder="https://ark.cn-beijing.volces.com/api/v3"
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="up-key">API Key</Label>
              <Input id="up-key" value={form.apiKey} onChange={(e) => set("apiKey", e.target.value)} required />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="up-models">模型（逗号分隔，* 表示全部）</Label>
              <Textarea
                id="up-models"
                rows={2}
                value={form.modelsText}
                onChange={(e) => set("modelsText", e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="up-priority">优先级（越小越优先）</Label>
                <Input
                  id="up-priority"
                  type="number"
                  value={form.priority}
                  onChange={(e) => set("priority", e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="up-concurrency">并发上限</Label>
                <Input
                  id="up-concurrency"
                  type="number"
                  value={form.concurrency}
                  onChange={(e) => set("concurrency", e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex flex-col">
                <Label htmlFor="up-enabled">启用</Label>
                <span className="text-xs text-muted-foreground">关闭后不参与调度</span>
              </div>
              <Switch id="up-enabled" checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex flex-col">
                <Label htmlFor="up-quota">套餐额度查询（Agent Plan）</Label>
                <span className="text-xs text-muted-foreground">
                  需要 IAM AK/SK；按量计费上游请保持关闭
                </span>
              </div>
              <Switch id="up-quota" checked={form.quotaEnabled} onCheckedChange={(v) => set("quotaEnabled", v)} />
            </div>

            {form.quotaEnabled ? (
              <div className="flex flex-col gap-3 rounded-lg border p-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="up-region">Region</Label>
                  <Input id="up-region" value={form.region} onChange={(e) => set("region", e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="up-ak">Access Key</Label>
                  <Input id="up-ak" value={form.accessKey} onChange={(e) => set("accessKey", e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="up-sk">Secret Key</Label>
                  <Input
                    id="up-sk"
                    type="password"
                    value={form.secretKey}
                    onChange={(e) => set("secretKey", e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="up-min">剩余低于该百分比时暂停调度</Label>
                  <Input
                    id="up-min"
                    type="number"
                    value={form.minRemainingPct}
                    onChange={(e) => set("minRemainingPct", e.target.value)}
                  />
                </div>
              </div>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>              <Button type="submit" disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}