"use client";

import { useState } from "react";
import { Check, Code2, Copy, Eye } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useResource } from "@/lib/client";
import { formatMs, formatNumber, formatTime } from "@/lib/format";
import type { RequestLogLine } from "@/lib/types";

interface LogDetail {
  log: RequestLogLine;
  req: string | null;
  resp: string | null;
  truncated: boolean;
}

interface ParsedMessage {
  role: string;
  text: string;
}

function extractPartText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    return content == null ? "" : JSON.stringify(content, null, 2);
  }
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") return p.text;
        if (p.type === "image_url") return "[图片]";
        return JSON.stringify(p);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseInputMessages(raw: string | null): ParsedMessage[] | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(obj.messages)) {
      return obj.messages.map((m) => {
        const msg = (m ?? {}) as Record<string, unknown>;
        return {
          role: typeof msg.role === "string" ? msg.role : "unknown",
          text: extractPartText(msg.content),
        };
      });
    }
    if (typeof obj.prompt === "string") {
      return [{ role: "prompt", text: obj.prompt }];
    }
    if (typeof obj.input === "string") {
      return [{ role: "input", text: obj.input }];
    }
    return null;
  } catch {
    return null;
  }
}

interface ParsedOutput {
  content: string;
  reasoning: string;
  toolCalls: unknown[];
}

function parseOutputBody(raw: string | null): ParsedOutput | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    // 1. 流式合并格式：{ content, reasoning, toolCalls }
    if (typeof obj.content === "string" || typeof obj.reasoning === "string" || Array.isArray(obj.toolCalls)) {
      return {
        content: typeof obj.content === "string" ? obj.content : "",
        reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
        toolCalls: Array.isArray(obj.toolCalls) ? obj.toolCalls : [],
      };
    }
    // 2. 非流式 OpenAI ChatCompletion
    if (Array.isArray(obj.choices) && obj.choices[0] && typeof obj.choices[0] === "object") {
      const c0 = obj.choices[0] as Record<string, unknown>;
      const msg = c0.message as Record<string, unknown> | undefined;
      if (msg && typeof msg === "object") {
        return {
          content: extractPartText(msg.content),
          reasoning:
            typeof msg.reasoning_content === "string"
              ? msg.reasoning_content
              : typeof msg.reasoning === "string"
                ? msg.reasoning
                : "",
          toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
        };
      }
      if (typeof c0.text === "string") {
        return { content: c0.text, reasoning: "", toolCalls: [] };
      }
    }
    // 3. Responses API 非流式 output_text
    if (typeof obj.output_text === "string") {
      return { content: obj.output_text, reasoning: "", toolCalls: [] };
    }
    return null;
  } catch {
    return null;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败");
    }
  };
  return (
    <Button type="button" variant="ghost" size="xs" onClick={copy}>
      {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      {copied ? "已复制" : "复制"}
    </Button>
  );
}

function prettyJson(raw: string | null): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default function LogsPage() {
  const [limit, setLimit] = useState("200");
  const [status, setStatus] = useState("all");
  const [keyId, setKeyId] = useState("");
  const [upId, setUpId] = useState("");
  const [model, setModel] = useState("");

  const [selected, setSelected] = useState<RequestLogLine | null>(null);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [rawInput, setRawInput] = useState(false);
  const [rawOutput, setRawOutput] = useState(false);

  const params = new URLSearchParams({ limit });
  if (status !== "all") params.set("status", status);
  if (keyId.trim()) params.set("keyId", keyId.trim());
  if (upId.trim()) params.set("upId", upId.trim());
  if (model.trim()) params.set("model", model.trim());

  const { data, error, loading } = useResource<{ logs: RequestLogLine[]; mysqlEnabled?: boolean }>(
    `/api/admin/logs?${params.toString()}`,
  );

  const openDetail = async (log: RequestLogLine) => {
    if (!log.id) return;
    setSelected(log);
    setDetail(null);
    setDetailError(null);
    setRawInput(false);
    setRawOutput(false);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/logs/${encodeURIComponent(log.id)}`);
      const json = (await res.json()) as { detail?: LogDetail; error?: string };
      if (!res.ok || !json.detail) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setDetail(json.detail);
    } catch (err) {
      setDetailError((err as Error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  const parsedInput = detail ? parseInputMessages(detail.req) : null;
  const parsedOutput = detail ? parseOutputBody(detail.resp) : null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">请求日志</h1>
        <p className="text-sm text-muted-foreground">
          {data?.mysqlEnabled
            ? "已启用 MySQL 日志存储，点击带「查看」标识的请求行可查看压缩归档的输入与输出正文。"
            : "当前未启用 MySQL，仅记录本地元数据（模型、状态、token、延迟）。配置 MYSQL_URL 后可查看输入输出正文。"}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-36 flex-col gap-1.5">
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
        <div className="flex w-28 flex-col gap-1.5">
          <Label htmlFor="log-limit">条数</Label>
          <Input id="log-limit" type="number" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </div>
        <div className="flex w-48 flex-col gap-1.5">
          <Label htmlFor="log-model">模型</Label>
          <Input id="log-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="精确模型名" />
        </div>
        <div className="flex w-36 flex-col gap-1.5">
          <Label htmlFor="log-key">下游 key id</Label>
          <Input id="log-key" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="k_xxx" />
        </div>
        <div className="flex w-36 flex-col gap-1.5">
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
                <TableHead className="text-right">重试</TableHead>
                <TableHead className="pr-4 text-right">正文</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.logs ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                    {loading ? "加载中…" : "没有匹配的请求"}
                  </TableCell>
                </TableRow>
              ) : (
                data?.logs.map((log, index) => {
                  const failed = log.status >= 400 || Boolean(log.err);
                  const canView = Boolean(log.id && log.hasBody);
                  return (
                    <TableRow
                      key={log.id ?? `${log.ts}-${index}`}
                      className={canView ? "cursor-pointer hover:bg-muted/50" : undefined}
                      onClick={canView ? () => openDetail(log) : undefined}
                    >
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
                      <TableCell className="text-right text-xs tabular-nums">
                        {formatNumber(log.pt)}
                        {log.cachedPt ? (
                          <span className="ml-1 text-[10px] text-muted-foreground">({formatNumber(log.cachedPt)}缓)</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{formatNumber(log.ct)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{formatMs(log.ttftMs)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{formatMs(log.ms)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                        {log.retries || "—"}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        {canView ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              void openDetail(log);
                            }}
                          >
                            <Eye className="size-3.5" />
                            查看
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 font-mono text-sm">
              <span>{selected?.model || "请求详情"}</span>
              {selected ? (
                <Badge variant={selected.status >= 400 || selected.err ? "destructive" : "secondary"}>
                  HTTP {selected.status}
                </Badge>
              ) : null}
              {detail?.truncated ? <Badge variant="outline">已截断</Badge> : null}
            </DialogTitle>
            {selected ? (
              <DialogDescription className="text-xs tabular-nums">
                {formatTime(selected.ts)} · 上游 {selected.upId || "—"} · Key {selected.keyId} · 输入{" "}
                {formatNumber(selected.pt)}
                {selected.cachedPt ? `（缓存 ${formatNumber(selected.cachedPt)}）` : ""} / 输出{" "}
                {formatNumber(selected.ct)} · 首字 {formatMs(selected.ttftMs)} / 耗时 {formatMs(selected.ms)}
              </DialogDescription>
            ) : null}
          </DialogHeader>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto pr-1">
            {detailLoading ? <p className="py-8 text-center text-sm text-muted-foreground">正在加载正文…</p> : null}
            {detailError ? <p className="py-4 text-sm text-destructive">{detailError}</p> : null}

            {detail ? (
              <>
                <section className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">输入</span>
                    <div className="flex items-center gap-1">
                      {parsedInput ? (
                        <Button type="button" variant="ghost" size="xs" onClick={() => setRawInput((v) => !v)}>
                          <Code2 className="size-3.5" />
                          {rawInput ? "结构化视图" : "原始 JSON"}
                        </Button>
                      ) : null}
                      {detail.req ? <CopyButton text={prettyJson(detail.req)} /> : null}
                    </div>
                  </div>
                  {!detail.req ? (
                    <p className="text-xs text-muted-foreground">无请求输入正文</p>
                  ) : rawInput || !parsedInput ? (
                    <pre className="max-h-72 overflow-auto rounded bg-muted/60 p-2.5 font-mono text-xs whitespace-pre-wrap break-all">
                      {prettyJson(detail.req)}
                    </pre>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {parsedInput.map((m, i) => (
                        <div key={i} className="rounded bg-muted/50 p-2.5">
                          <div className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">{m.role}</div>
                          <pre className="font-sans text-xs whitespace-pre-wrap break-words">{m.text || "—"}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">输出</span>
                    <div className="flex items-center gap-1">
                      {parsedOutput ? (
                        <Button type="button" variant="ghost" size="xs" onClick={() => setRawOutput((v) => !v)}>
                          <Code2 className="size-3.5" />
                          {rawOutput ? "结构化视图" : "原始 JSON"}
                        </Button>
                      ) : null}
                      {detail.resp ? <CopyButton text={prettyJson(detail.resp)} /> : null}
                    </div>
                  </div>
                  {!detail.resp ? (
                    <p className="text-xs text-muted-foreground">无响应输出正文</p>
                  ) : rawOutput || !parsedOutput ? (
                    <pre className="max-h-80 overflow-auto rounded bg-muted/60 p-2.5 font-mono text-xs whitespace-pre-wrap break-all">
                      {prettyJson(detail.resp)}
                    </pre>
                  ) : (
                    <div className="flex flex-col gap-2.5">
                      {parsedOutput.reasoning ? (
                        <details className="rounded border bg-muted/30 p-2.5">
                          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                            思考过程（{parsedOutput.reasoning.length} 字符）
                          </summary>
                          <pre className="mt-2 font-sans text-xs whitespace-pre-wrap break-words text-muted-foreground">
                            {parsedOutput.reasoning}
                          </pre>
                        </details>
                      ) : null}
                      {parsedOutput.content ? (
                        <div className="rounded bg-muted/50 p-2.5">
                          <pre className="font-sans text-xs whitespace-pre-wrap break-words">{parsedOutput.content}</pre>
                        </div>
                      ) : null}
                      {parsedOutput.toolCalls.length > 0 ? (
                        <div className="rounded bg-muted/50 p-2.5">
                          <div className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Tool Calls</div>
                          <pre className="overflow-auto font-mono text-xs whitespace-pre-wrap break-all">
                            {JSON.stringify(parsedOutput.toolCalls, null, 2)}
                          </pre>
                        </div>
                      ) : null}
                      {!parsedOutput.reasoning && !parsedOutput.content && parsedOutput.toolCalls.length === 0 ? (
                        <p className="text-xs text-muted-foreground">空输出</p>
                      ) : null}
                    </div>
                  )}
                </section>
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
