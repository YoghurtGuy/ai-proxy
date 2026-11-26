"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  | "weights.topK"
  | "traffic.burstQueueWaitMs"
  | "traffic.burstQueueMaxSize"
  | "traffic.slopeWindowSec"
  | "traffic.slopeMaxGrowthRatio"
  | "traffic.slopeMinBaseline"
  | "trace.maxBodyKb";

type Form = Record<NumericKey, string> & {
  "traffic.enabled": boolean;
  "trace.enabled": boolean;
};

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
    "traffic.enabled": settings.traffic.enabled,
    "traffic.burstQueueWaitMs": String(settings.traffic.burstQueueWaitMs),
    "traffic.burstQueueMaxSize": String(settings.traffic.burstQueueMaxSize),
    "traffic.slopeWindowSec": String(settings.traffic.slopeWindowSec),
    "traffic.slopeMaxGrowthRatio": String(settings.traffic.slopeMaxGrowthRatio),
    "traffic.slopeMinBaseline": String(settings.traffic.slopeMinBaseline),
    "trace.enabled": settings.trace.enabled,
    "trace.maxBodyKb": String(settings.trace.maxBodyKb),
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
    traffic: {
      enabled: form["traffic.enabled"],
      burstQueueWaitMs: n("traffic.burstQueueWaitMs"),
      burstQueueMaxSize: n("traffic.burstQueueMaxSize"),
      slopeWindowSec: n("traffic.slopeWindowSec"),
      slopeMaxGrowthRatio: n("traffic.slopeMaxGrowthRatio"),
      slopeMinBaseline: n("traffic.slopeMinBaseline"),
    },
    trace: {
      enabled: form["trace.enabled"],
      maxBodyKb: n("trace.maxBodyKb"),
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

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
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
        <p className="text-sm text-muted-foreground">
          保存后立即对后续请求生效（配置 MYSQL_URL 时写入 MySQL，否则写入 config.json）。
        </p>
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

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>突发流量与斜率保护</CardTitle>
              <CardDescription>仅针对上游：并发满时按模型排队平滑毛刺，并按「上游 × 模型」隔离限制跨周期增速</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="traffic-enabled">启用保护</Label>
              <Switch
                id="traffic-enabled"
                checked={form["traffic.enabled"]}
                onCheckedChange={(v) => set("traffic.enabled", v)}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            id="t-wait"
            label="排队最大等待（毫秒）"
            hint="并发满时等待槽位释放，0 关闭排队"
            value={form["traffic.burstQueueWaitMs"]}
            onChange={(v) => set("traffic.burstQueueWaitMs", v)}
          />
          <Field
            id="t-qsize"
            label="排队队列上限"
            hint="超出后直接返回限流，防止请求堆积"
            value={form["traffic.burstQueueMaxSize"]}
            onChange={(v) => set("traffic.burstQueueMaxSize", v)}
          />
          <Field
            id="t-window"
            label="斜率统计窗口（秒）"
            hint="0 关闭斜率保护，推荐 60～180 秒"
            value={form["traffic.slopeWindowSec"]}
            onChange={(v) => set("traffic.slopeWindowSec", v)}
          />
          <Field
            id="t-ratio"
            label="允许周期增长比例"
            hint="如 0.5 表示最多比上周期多 50%"
            value={form["traffic.slopeMaxGrowthRatio"]}
            onChange={(v) => set("traffic.slopeMaxGrowthRatio", v)}
          />
          <Field
            id="t-base"
            label="触发基线最低请求数"
            hint="上周期请求低于此值时不限流，防冷启动误杀"
            value={form["traffic.slopeMinBaseline"]}
            onChange={(v) => set("traffic.slopeMinBaseline", v)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>请求正文记录（Debug）</CardTitle>
              <CardDescription>仅在配置 MYSQL_URL 时生效，异步压缩存储输入与输出供请求日志详情查看</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="trace-enabled">记录正文</Label>
              <Switch
                id="trace-enabled"
                checked={form["trace.enabled"]}
                onCheckedChange={(v) => set("trace.enabled", v)}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            id="trace-kb"
            label="单条正文截断上限（KB）"
            hint="输入与输出各自限制（4～2048 KB），超长自动截断，Base64 图片自动脱敏"
            value={form["trace.maxBodyKb"]}
            onChange={(v) => set("trace.maxBodyKb", v)}
          />
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