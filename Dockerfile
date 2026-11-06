# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 依赖层：只复制清单文件，源码变动时不用重装依赖
# ---------------------------------------------------------------------------
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# 构建层：产出 next 的 standalone 自包含产物
# ---------------------------------------------------------------------------
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# ---------------------------------------------------------------------------
# 运行层：只带 server.js + 静态资源，不带源码和依赖清单
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data

ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="ai-proxy" \
      org.opencontainers.image.description="LLM 转发网关：上游负载均衡、套餐额度轮询、下游 key 分发" \
      org.opencontainers.image.version="${APP_VERSION}"

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# 配置、用量、请求明细都写在这里，挂卷持久化
RUN mkdir -p /data && chown nextjs:nodejs /data
VOLUME ["/data"]

USER nextjs
EXPOSE 3000

# /login 不需要鉴权，且能同时验证 node 进程和路由都在
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1

CMD ["node", "server.js"]