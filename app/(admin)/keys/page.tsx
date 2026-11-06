"use client";

import { useState } from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { apiSend, useResource } from "@/lib/client";
import { formatNumber, maskKey } from "@/lib/format";
import type { DownstreamKey, KeyLimits } from "@/lib/types";

interface KeyRow extends DownstreamKey {
  today?: unknown;
}

interface FormState {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  rpm: string;
  concurrency: string;
  dailyRequests: string;
  dailyTokens: string;
  allowedModelsText: string;
  expiresAt: string;
}

const EMPTY_FORM: FormState = {
  id: "",
  name: "",
  key: "",
  enabled: true,
  rpm: "0",
  concurrency: "0",
  dailyRequests: "0",
  dailyTokens: "0",
  allowedModelsText: "*",
  expiresAt: "",
};

function toForm(key: KeyRow): FormState {
  return {
    id: key.id,
    name: key.name,
    key: key.key,
    enabled: key.enabled,
    rpm: String(key.limits.rpm),
    concurrency: String(key.limits.concurrency),
    dailyRequests: String(key.limits.dailyRequests),
    dailyTokens: String(key.limits.dailyTokens),
    allowedModelsText: key.limits.allowedModels.join(", "),
    expiresAt: key.limits.expiresAt ?? "",
  };
}

function payloadOf(form: FormState) {
  const models = form.allowedModelsText
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const limits: KeyLimits = {
    rpm: Number(form.rpm) || 0,
    concurrency: Number(form.concurrency) || 0,
    dailyRequests: Number(form.dailyRequests) || 0,
    dailyTokens: Number(form.dailyTokens) || 0,
    allowedModels: models.length ? models : ["*"],
    expiresAt: form.expiresAt.trim() || null,
  };
  const body: Record<string, unknown> = { name: form.name.trim(), enabled: form.enabled, limits };
  // 新建时留空由后端生成；编辑时保持原值
  if (form.key.trim()) body.key = form.key.trim();
  return body;
}

function limitSummary(limits: KeyLimits): string {
  const parts: string[] = [];
  if (limits.rpm) parts.push(`${limits.rpm} 次/分`);
  if (limits.concurrency) parts.push(`并发 ${limits.concurrency}`);
  if (limits.dailyRequests) parts.push(`${formatNumber(limits.dailyRequests)} 次/天`);
  if (limits.dailyTokens) parts.push(`${formatNumber(limits.dailyTokens)} token/天`);
  return parts.length ? parts.join(" · ") : "不限";
}

export default function KeysPage() {
  const { data, error, reload } = useResource<{ keys: KeyRow[] }>("/api/admin/keys");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setOpen(true);
  };

  const openEdit = (key: KeyRow) => {
    setForm(toForm(key));
    setOpen(true);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (form.id) {
        await apiSend("/api/admin/keys", "PUT", { ...payloadOf(form), id: form.id });
        toast.success("已保存");
      } else {
        await apiSend("/api/admin/keys", "POST", payloadOf(form));
        toast.success("已创建 key");
      }
      setOpen(false);
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key: KeyRow) => {
    if (!confirm(`确定删除 key「${key.name}」？`)) return;
    try {
      await apiSend(`/api/admin/keys?id=${encodeURIComponent(key.id)}`, "DELETE");
      toast.success("已删除");
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const toggleEnabled = async (key: KeyRow, enabled: boolean) => {
    try {
      await apiSend("/api/admin/keys", "PUT", { id: key.id, enabled });
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const copy = async (key: KeyRow) => {
    try {
      await navigator.clipboard.writeText(key.key);
      toast.success("已复制到剪贴板");
    } catch {
      toast.error("复制失败，请手动选中");
    }
  };

  const toggleReveal = (id: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold">下游 Key</h1>
          <p className="text-sm text-muted-foreground">下发给客户端的凭证，可限制速率、并发、每日用量和可用模型。</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          创建 Key
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
                <TableHead>Key</TableHead>
                <TableHead>限制</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>启用</TableHead>
                <TableHead className="pr-4 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.keys ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    还没有下游 key
                  </TableCell>
                </TableRow>
              ) : (
                data?.keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="pl-4">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">{key.name}</span>
                        {key.limits.expiresAt ? (
                          <span className="text-xs text-muted-foreground">到期 {key.limits.expiresAt}</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="font-mono text-xs text-muted-foreground hover:text-foreground"
                        title="点击显示/隐藏"
                        onClick={() => toggleReveal(key.id)}
                      >
                        {revealed.has(key.id) ? key.key : maskKey(key.key)}
                      </button>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{limitSummary(key.limits)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {key.limits.allowedModels.includes("*") ? "全部" : key.limits.allowedModels.join(", ")}
                    </TableCell>
                    <TableCell>
                      <Switch checked={key.enabled} onCheckedChange={(v) => toggleEnabled(key, v)} />
                    </TableCell>
                    <TableCell className="pr-4">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" title="复制" onClick={() => copy(key)}>
                          <Copy className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => openEdit(key)}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" title="删除" onClick={() => remove(key)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        客户端用法：<code className="rounded bg-muted px-1">Authorization: Bearer sk-...</code>，Base URL 填本站
        <code className="rounded bg-muted px-1">/v1</code>
      </p>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{form.id ? "编辑 Key" : "创建 Key"}</DialogTitle>
              <DialogDescription>留空则由服务端生成 sk- 开头的 48 位 key</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-name">名称</Label>
              <Input
                id="key-name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="team-a"
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-value">Key（可留空自动生成）</Label>
              <Input
                id="key-value"
                className="font-mono"
                value={form.key}
                onChange={(e) => set("key", e.target.value)}
                placeholder="sk-..."
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="key-rpm">每分钟请求数（0 不限）</Label>
                <Input id="key-rpm" type="number" value={form.rpm} onChange={(e) => set("rpm", e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="key-conc">并发上限（0 不限）</Label>
                <Input
                  id="key-conc"
                  type="number"
                  value={form.concurrency}
                  onChange={(e) => set("concurrency", e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="key-daily-req">每日请求（0 不限）</Label>
                <Input
                  id="key-daily-req"
                  type="number"
                  value={form.dailyRequests}
                  onChange={(e) => set("dailyRequests", e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="key-daily-tok">每日 token（0 不限）</Label>
                <Input
                  id="key-daily-tok"
                  type="number"
                  value={form.dailyTokens}
                  onChange={(e) => set("dailyTokens", e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-models">允许的模型（逗号分隔，* 表示全部）</Label>
              <Input
                id="key-models"
                value={form.allowedModelsText}
                onChange={(e) => set("allowedModelsText", e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-exp">过期时间（ISO，留空不过期）</Label>
              <Input
                id="key-exp"
                value={form.expiresAt}
                onChange={(e) => set("expiresAt", e.target.value)}
                placeholder="2026-12-31T00:00:00Z"
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex flex-col">
                <Label htmlFor="key-enabled">启用</Label>
                <span className="text-xs text-muted-foreground">关闭后该 key 的请求会直接被拒绝</span>
              </div>
              <Switch id="key-enabled" checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}