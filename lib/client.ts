"use client";

import { useCallback, useEffect, useState } from "react";

/** 管理端 API 的薄封装：统一错误信息、401 跳登录。 */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      // 会话失效要丢掉整个前端状态，客户端路由跳转做不到，这里就用整页跳转。
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/login";
    }
    const message = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { cache: "no-store" }));
}

export async function apiSend<T>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  return parse<T>(
    await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

interface ResourceState<T> {
  /** 产生这份数据时请求的 path，用来判断当前 path 是否已经有结果 */
  path: string;
  data: T | null;
  error: string | null;
}

/**
 * 拉取一份管理端数据。
 *
 * loading 由「当前 path 是否已有结果」推导，而不是在 effect 里 setState：
 * 这样既避开 cascading render，也让自动刷新不会整块闪一下。
 */
export function useResource<T>(path: string | null, deps: unknown[] = []) {
  const [state, setState] = useState<ResourceState<T> | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    apiGet<T>(path)
      .then((result) => {
        if (alive) setState({ path, data: result, error: null });
      })
      .catch((err: Error) => {
        if (alive) setState((prev) => ({ path, data: prev?.path === path ? prev.data : null, error: err.message }));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  const fresh = state?.path === path ? state : null;
  return {
    data: fresh?.data ?? null,
    error: fresh?.error ?? null,
    loading: Boolean(path) && !fresh,
    reload,
  };
}

/** 周期性刷新的当前时间，用于冷却倒计时这类展示。 */
export function useNow(intervalMs = 5000): number {
  // 不能在这里直接读 Date.now()：客户端组件的渲染期会在构建时被预渲染，
  // Next 会报「unstable value」错误。首帧先给 0，挂载后再补上。
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, intervalMs);
    const kickoff = setTimeout(tick, 0);
    return () => {
      clearInterval(timer);
      clearTimeout(kickoff);
    };
  }, [intervalMs]);
  return now;
}