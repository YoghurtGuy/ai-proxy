/**
 * Next.js 启动钩子。
 *
 * 这里故意只做一次动态 import：instrumentation 会被同时编译进 Node 和 Edge 两个包，
 * 静态 import node:fs 之类的模块会让 Edge 包报一堆不支持的警告。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { bootstrap } = await import("./lib/boot");
  await bootstrap();
}