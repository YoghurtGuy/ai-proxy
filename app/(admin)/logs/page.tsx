"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useResource } from "@/lib/client";
import { formatMs, formatNumber, formatTime } from "@/lib/format";
import type { RequestLogLine } from "@/lib/types";

export default function LogsPage() {
  const [limit, setLimit] = useState("200");
  const [status, setStatus] = useState("all");
  const [keyId, setKeyId] = useState("");
  const [upId, setUpId] = useState("");

  const params = new URLSearchParams({ limit });
  if (status !== "all") params.set("status", status);
  if (keyId.trim()) params.set("keyId", keyId.trim());
  if (upId.trim()) params.set("upId", upId.trim());

  const { data, error, loading } = useResource<{ logs: RequestLogLine[] }>(`/api/admin/logs?${params.toString()}`);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">请求日志</h1>
        <p className="text-sm text-muted-foreground">
          只记录元数据（模型、状态、token、延迟），不保存 prompt 和输出内容。按天滚动，超出保留期自动删除。
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-40 flex-col gap-1.5">
          <Label htmlFor="log-status">状态</Label>
          <Select value={status} onValueChange={(v) => setStatus(String(v))}>
            <SelectTrigger id="log-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="ok">成功</SelectItem>
              <SelectItem value="error">失败</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex w-36 flex-col gap-1.5">
          <Label htmlFor="log-limit">条数</Label>
          <Input id="log-limit" type="number" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </div>
        <div className="flex w-40 flex-col gap-1.5">
          <Label htmlFor="log-key">下游 key id</Label>
          <Input id="log-key" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="k_xxx" />
        </div>
        <div className="flex w-40 flex-col gap-1.5">
          <Label htmlFor="log-up">上游 id</Label>
          <Input id="log-up" value={upId} onChange={(e) => setUpId(e.target.value)} placeholder="u_xxx" />
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
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">时间</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">输入</TableHead>
                <TableHead className="text-right">输出</TableHead>
                <TableHead className="text-right">首字</TableHead>
                <TableHead className="text-right">耗时</TableHead>
                <TableHead className="pr-4 text-right">重试</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.logs ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    {loading ? "加载中…" : "没有匹配的请求"}
                  </TableCell>
                </TableRow>
              ) : (
                data?.logs.map((log, index) => {
                  const failed = log.status >= 400 || Boolean(log.err);
                  return (
                    <TableRow key={`${log.ts}-${index}`}>
                      <TableCell className="pl-4 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                        {formatTime(log.ts)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-mono text-xs">{log.model || "—"}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {log.upId || "—"} · {log.keyId}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className={failed ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
                          {log.status}
                          {log.stream ? " · 流式" : ""}
                        </span>
                        {log.err ? (
                          <div className="max-w-[220px] truncate text-[11px] text-destructive" title={log.err}>
                            {log.err}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{formatNumber(log.pt)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{formatNumber(log.ct)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{formatMs(log.ttftMs)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{formatMs(log.ms)}</TableCell>
                      <TableCell className="pr-4 text-right text-xs tabular-nums text-muted-foreground">
                        {log.retries || "—"}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}