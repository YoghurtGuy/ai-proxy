import { fetchVolcengineQuota } from "./quota/volcengine";
import { pruneRuntime, setQuota } from "./scheduler";
import { cleanupOldLogs, flushLogs, flushUsage, loadUsage } from "./stats";
import { DATA_DIR, flushWrites, getConfig, loadConfig } from "./store";

/**
 * 只在 nodejs 运行时执行的启动逻辑。
 * 单独成文件是为了让 instrumentation.ts 保持无副作用，避免 Node API 被打进 Edge 包。
 */

const g = globalThis as unknown as { __aiProxyBooted?: boolean };

async function pollQuotas(): Promise<number> {
  const config = await getConfig();
  let fetched = 0;
  for (const up of config.upstreams) {
    if (!up.quota?.accessKey || !up.quota?.secretKey) continue;
    const snapshot = await fetchVolcengineQuota(up.quota);
    setQuota(up.id, snapshot);
    fetched += 1;
    if (snapshot.error) console.warn(`[quota] ${up.name} 额度获取失败: ${snapshot.error}`);
  }
  return fetched;
}

export async function bootstrap(): Promise<void> {
  if (g.__aiProxyBooted) return;
  g.__aiProxyBooted = true;

  const config = await loadConfig();
  pruneRuntime(config);
  await loadUsage();
  const removed = await cleanupOldLogs(config.settings.logRetentionDays);

  void pollQuotas().catch((err) => console.error("[quota] 首次轮询失败:", (err as Error).message));

  if (config.settings.quotaPollSec > 0) {
    const quotaTimer = setInterval(() => {
      void pollQuotas().catch((err) => console.error("[quota] 轮询异常:", (err as Error).message));
    }, config.settings.quotaPollSec * 1000);
    quotaTimer.unref();
  }

  const cleanupTimer = setInterval(
    () => {
      void getConfig()
        .then((c) => cleanupOldLogs(c.settings.logRetentionDays))
        .catch(() => undefined);
    },
    24 * 60 * 60 * 1000,
  );
  cleanupTimer.unref();

  console.log(
    `[ai-proxy] 配置加载完成：${config.upstreams.length} 个上游 / ${config.keys.length} 个下游 key` +
      `，数据目录 ${DATA_DIR}${removed ? `，清理了 ${removed} 个过期日志` : ""}`,
  );
  if (!config.upstreams.some((u) => u.quota?.accessKey)) {
    console.log("[ai-proxy] 没有上游配置套餐额度查询，按量计费上游不需要额度轮询");
  }
  if (!process.env.ADMIN_PASSWORD && !process.env.AUTH_SECRET) {
    console.warn("[ai-proxy] 未设置 ADMIN_PASSWORD，管理端无法登录");
  }

  const shutdown = () => {
    void (async () => {
      await flushLogs();
      await flushUsage();
      await flushWrites();
    })();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}