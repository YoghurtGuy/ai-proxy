"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiSend, useResource } from "@/lib/client";
import type { Settings } from "@/lib/types";

type NumericKey =
  | "quotaPollSec"
  | "cooldownDefaultSec"
  | "cooldownMaxSec"
  | "stickyTtlMin"
  | "maxAttempts"
  | "logRetentionDays"
  | "weights.priority"
  | "weights.load"
  | "weights.quota"
  | "weights.errorRate"
  | "weights.topK";

type Form = Record<NumericKey, string>;

function toForm(settings: Settings): Form {
  return {
    quotaPollSec: String(settings.quotaPollSec),
    cooldownDefaultSec: String(settings.cooldownDefaultSec),
    cooldownMaxSec: String(settings.cooldownMaxSec),
    stickyTtlMin: String(settings.stickyTtlMin),
    maxAttempts: String(settings.maxAttempts),
    logRetentionDays: String(settings.logRetentionDays),
    "weights.priority": String(settings.weights.priority),
    "weights.load": String(settings.weights.load),
    "weights.quota": String(settings.weights.quota),
    "weights.errorRate": String(settings.weights.errorRate),
    "weights.topK": String(settings.weights.topK),
  };
}

function payloadOf(form: Form): Settings {
  const n = (key: NumericKey) => Number(form[key]) || 0;
  return {
    quotaPollSec: n("quotaPollSec"),
    cooldownDefaultSec: n("cooldownDefaultSec"),
    cooldownMaxSec: n("cooldownMaxSec"),
    stickyTtlMin: n("stickyTtlMin"),
    maxAttempts: n("maxAttempts"),
    logRetentionDays: n("logRetentionDays"),
    weights: {
      priority: n("weights.priority"),
      load: n("weights.load"),
      quota: n("weights.quota"),
      errorRate: n("weights.errorRate"),
      topK: n("weights.topK"),
    },
  };
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export default function SettingsPage() {
  const { data, error, reload } = useResource<{ settings: Settings }>("/api/admin/settings");
  const [draft, setDraft] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);

  // 没改过就直接用服务端数据，避免在 effect 里 setState 造成级联渲染
  const form = draft ?? (data ? toForm(data.settings) : null);

  const set = (key: NumericKey, value: string) =>
    setDraft((prev) => {
      const base = prev ?? (data ? toForm(data.settings) : null);
      return base ? { ...base, [key]: value } : prev;
    });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    try {
      await apiSend("/api/admin/settings", "PUT", payloadOf(form));
      toast.success("已保存，额度轮询间隔下次启动生效");
      setDraft(null);
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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

  if (!form) return <p className="text-sm text-muted-foreground">加载中…</p>;

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">设置</h1>
        <p className="text-sm text-muted-foreground">写入 config.json，保存后立即对后续请求生效。</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>额度与冷却</CardTitle>
          <CardDescription>控制套餐额度的拉取频率和上游被限流后的回避时长</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            id="quotaPollSec"
            label="额度轮询间隔（秒，0 关闭）"
            hint="改为 0 可完全关掉火山 API 调用"
            value={form.quotaPollSec}
            onChange={(v) => set("quotaPollSec", v)}
          />
          <Field
            id="logRetentionDays"
            label="明细日志保留天数"
            value={form.logRetentionDays}
            onChange={(v) => set("logRetentionDays", v)}
          />
          <Field
            id="cooldownDefaultSec"
            label="429 兜底冷却（秒）"
            hint="上游没给重置时间时用这个"
            value={form.cooldownDefaultSec}
            onChange={(v) => set("cooldownDefaultSec", v)}
          />
          <Field
            id="cooldownMaxSec"
            label="冷却上限（秒）"
            value={form.cooldownMaxSec}
            onChange={(v) => set("cooldownMaxSec", v)}
          />
          <Field
            id="maxAttempts"
            label="单请求最多尝试上游数"
            value={form.maxAttempts}
            onChange={(v) => set("maxAttempts", v)}
          />
          <Field
            id="stickyTtlMin"
            label="粘性会话 TTL（分钟，0 关闭）"
            hint="同一对话锁定同一上游，命中 KV cache"
            value={form.stickyTtlMin}
            onChange={(v) => set("stickyTtlMin", v)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>调度权重</CardTitle>
          <CardDescription>
            总分 = 优先级×w1 + 负载×w2 + 额度余量×w3 + 健康度×w4，然后在前 topK 名里加权随机
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="w-priority" label="优先级权重" value={form["weights.priority"]} onChange={(v) => set("weights.priority", v)} />
          <Field id="w-load" label="负载权重" value={form["weights.load"]} onChange={(v) => set("weights.load", v)} />
          <Field id="w-quota" label="额度余量权重" value={form["weights.quota"]} onChange={(v) => set("weights.quota", v)} />
          <Field
            id="w-error"
            label="健康度权重"
            value={form["weights.errorRate"]}
            onChange={(v) => set("weights.errorRate", v)}
          />
          <Field id="w-topk" label="topK" hint="越大越分散" value={form["weights.topK"]} onChange={(v) => set("weights.topK", v)} />
        </CardContent>
      </Card>

      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存设置"}
        </Button>
      </div>
    </form>
  );
}