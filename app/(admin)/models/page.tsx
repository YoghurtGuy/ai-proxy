"use client";

import { useMemo, useState } from "react";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiSend, useResource } from "@/lib/client";
import { formatCost, formatNumber } from "@/lib/format";
import type { ModelPricing } from "@/lib/types";

interface ModelRow {
  id: string;
  upstreams: { id: string; name: string }[];
  pricing: ModelPricing | null;
  today: {
    req: number;
    err: number;
    pt: number;
    ct: number;
    cachedPt: number;
    tokens: number;
    cost: number | null;
  };
}

interface PriceForm {
  model: string;
  inputPerM: string;
  cachedInputPerM: string;
  outputPerM: string;
  isNew: boolean;
}

const EMPTY_FORM: PriceForm = {
  model: "",
  inputPerM: "0",
  cachedInputPerM: "0",
  outputPerM: "0",
  isNew: true,
};

function formatPrice(val: number): string {
  return `¥${val}`;
}

export default function ModelsPage() {
  const { data, error, reload } = useResource<{ models: ModelRow[] }>("/api/admin/models");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<PriceForm | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const list = data?.models ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) => m.id.toLowerCase().includes(q) || m.upstreams.some((u) => u.name.toLowerCase().includes(q)),
    );
  }, [data, query]);

  const refreshModels = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin/models?refresh=1");
      if (!res.ok) throw new Error(`刷新失败: HTTP ${res.status}`);
      toast.success("已刷新上游模型列表");
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const openEdit = (row: ModelRow) => {
    setEditing({
      model: row.id,
      inputPerM: String(row.pricing?.inputPerM ?? 0),
      cachedInputPerM: String(row.pricing?.cachedInputPerM ?? 0),
      outputPerM: String(row.pricing?.outputPerM ?? 0),
      isNew: false,
    });
  };

  const savePrice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const model = editing.model.trim();
    if (!model) {
      toast.error("请输入模型 ID");
      return;
    }
    setBusy(true);
    try {
      await apiSend("/api/admin/models", "PUT", {
        model,
        inputPerM: Number(editing.inputPerM) || 0,
        cachedInputPerM: Number(editing.cachedInputPerM) || 0,
        outputPerM: Number(editing.outputPerM) || 0,
      });
      toast.success(`已保存 ${model} 的价格配置`);
      setEditing(null);
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removePrice = async (model: string) => {
    try {
      await apiSend("/api/admin/models", "PUT", { model, remove: true });
      toast.success(`已清除 ${model} 的价格配置`);
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold">模型列表</h1>
          <p className="text-sm text-muted-foreground">
            设置常规在线推理单价（元 / 百万 Token），仪表盘将按实际输入、缓存命中与输出 Token 自动计算费用。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refreshModels} disabled={refreshing}>
            <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
            刷新模型
          </Button>
          <Button size="sm" onClick={() => setEditing({ ...EMPTY_FORM })}>
            <Plus className="size-4" />
            添加模型价格
          </Button>
        </div>
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
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>模型与定价</CardTitle>
              <CardDescription>
                共 {data?.models.length ?? 0} 个模型 · 已定价 {data?.models.filter((m) => m.pricing).length ?? 0} 个
              </CardDescription>
            </div>
            <Input
              className="w-64"
              placeholder="搜索模型 ID 或上游名称…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">模型 ID</TableHead>
                <TableHead>提供上游</TableHead>
                <TableHead className="text-right">输入 (元/M)</TableHead>
                <TableHead className="text-right">缓存命中 (元/M)</TableHead>
                <TableHead className="text-right">输出 (元/M)</TableHead>
                <TableHead className="text-right">今日用量</TableHead>
                <TableHead className="text-right">今日预估费用</TableHead>
                <TableHead className="pr-4 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    {data ? "没有匹配的模型" : "加载中…"}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="pl-4 font-mono text-xs">{row.id}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {row.upstreams.length === 0 ? (
                          <span className="text-xs text-muted-foreground">手动/历史</span>
                        ) : (
                          row.upstreams.map((u) => (
                            <Badge key={u.id} variant="secondary" className="font-normal">
                              {u.name}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {row.pricing ? formatPrice(row.pricing.inputPerM) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {row.pricing ? formatPrice(row.pricing.cachedInputPerM) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {row.pricing ? formatPrice(row.pricing.outputPerM) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                      {row.today.req > 0 ? (
                        <div>
                          <div>{formatNumber(row.today.tokens)}</div>
                          {row.today.cachedPt > 0 ? (
                            <div className="text-[11px]">含缓存 {formatNumber(row.today.cachedPt)}</div>
                          ) : null}
                        </div>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm font-medium">
                      {row.today.cost !== null ? formatCost(row.today.cost) : <span className="text-muted-foreground">未定价</span>}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon-xs" title="编辑价格" onClick={() => openEdit(row)}>
                          <Pencil className="size-3.5" />
                        </Button>
                        {row.pricing ? (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            title="清除价格"
                            onClick={() => removePrice(row.id)}
                          >
                            <Trash2 className="size-3.5 text-destructive" />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.isNew ? "添加模型价格" : "编辑模型价格"}</DialogTitle>
            <DialogDescription>
              填写常规在线推理单价（元 / 百万 Token）。未命中缓存的输入按「常规输入」计费，缓存命中部分按「缓存命中」计费。
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <form onSubmit={savePrice} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="m-id">模型 ID</Label>
                <Input
                  id="m-id"
                  value={editing.model}
                  disabled={!editing.isNew}
                  placeholder="例如 doubao-seed-2-1-lite-260915"
                  onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="m-in">常规输入 (元/M)</Label>
                  <Input
                    id="m-in"
                    type="number"
                    step="any"
                    min="0"
                    value={editing.inputPerM}
                    onChange={(e) => setEditing({ ...editing, inputPerM: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="m-cache">缓存命中 (元/M)</Label>
                  <Input
                    id="m-cache"
                    type="number"
                    step="any"
                    min="0"
                    value={editing.cachedInputPerM}
                    onChange={(e) => setEditing({ ...editing, cachedInputPerM: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="m-out">输出 (元/M)</Label>
                  <Input
                    id="m-out"
                    type="number"
                    step="any"
                    min="0"
                    value={editing.outputPerM}
                    onChange={(e) => setEditing({ ...editing, outputPerM: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  取消
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "保存中…" : "保存"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
