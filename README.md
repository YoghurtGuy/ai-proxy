# ai-proxy

LLM 的转发网关：上游多账号负载均衡 + 失败换号 + 套餐额度轮询 + 下游 key 分发 + 管理后台。

**不用数据库、不用 Redis。** 配置和用量都是 `data/` 下的 JSON 文件，启动时读进内存。

---

## 快速开始

```bash
bun install
cp .env.example .env.local     # 改掉里面的密码
bun run build
bun run start                  # http://localhost:3000
```

打开 `http://localhost:3000` 用 `ADMIN_PASSWORD` 登录，然后在「上游」页加上游、「下游 Key」页创建 key。

客户端这样接：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-你创建的key" \
  -H "Content-Type: application/json" \
  -d '{"model":"doubao-seed-2-1-pro","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Base URL 填 `http://<host>:3000/v1`，和 OpenAI 完全一致。

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 是 | 管理后台登录密码 |
| `AUTH_SECRET` | 否 | cookie 签名密钥，不填则用 `ADMIN_PASSWORD` |
| `DATA_DIR` | 否 | 数据目录，默认 `./data` |

---

## 数据文件

全部在 `DATA_DIR` 下，没有外部依赖。

| 文件 | 内容 |
|---|---|
| `config.json` | 上游、下游 key、调度设置。可在界面里改，也可手改后点侧边栏「重载配置」 |
| `usage.json` | 按天 × 维度（上游 / key / 模型）的累计计数，3 秒防抖原子落盘 |
| `logs/YYYY-MM-DD.jsonl` | 逐请求明细，按天滚动，超过保留期自动删除 |

明细里**只记元数据**（模型、状态码、token 数、延迟），不保存 prompt 和输出正文。

> 注意：`config.json` 里上游的 API Key 和 IAM Secret Key 是明文存储。这个文件按密钥对待，不要提交进 git（`data/` 已在 `.gitignore` 里）。

---

## 上游类型

**两种都支持，同一个上游列表里可以混用：**

| 类型 | 怎么配 | 行为 |
|---|---|---|
| 套餐额度（Agent Plan） | 填 IAM AK/SK，打开「套餐额度查询」 | 定时拉 5 小时 / 日 / 周 / 月四个窗口的 AFP 额度；剩余低于阈值就暂停调度 |
| 按量计费 | 额度留空 | 不参与额度调度，只用优先级 / 负载 / 健康度均衡 |

### 火山方舟的 Base URL 与 key 前缀必须配对

这是最容易踩的坑：`ark-` 开头的 key 是套餐专属 key，填到按量计费入口会直接 401
（`The API key or AK/SK in the request is missing or invalid`）。

| 权益 | OpenAI 兼容 Base URL | Anthropic 兼容 |
|---|---|---|
| 按量计费 | `https://ark.cn-beijing.volces.com/api/v3` | — |
| Agent Plan | `https://ark.cn-beijing.volces.com/api/plan/v3` | `…/api/plan` |
| Coding Plan | `https://ark.cn-beijing.volces.com/api/coding/v3` | `…/api/coding` |

key 前缀对应关系：`sk-…` → 按量计费；`ark-…` → 套餐专属。

另外 Agent Plan 的入口**没有 `/models` 路由**（返回 404），所以：

- **测试按钮**做两步探测：先打 `/models`，拿到 404 再发一个缺 `model` 的空
  `POST /chat/completions`——这种请求会在鉴权之后、生成之前被拒（400），
  既能确认连通又不消耗额度。
- **模型列表**改走管控面 `ListArkAgentPlanModel`（需要该上游填了 AK/SK），
  返回 27 个模型并带 `Load.Status` 实时可用性；不可用的会被过滤掉。
  结果缓存 10 分钟——这套接口有 QPS 限制，打太快会返回 `AccountFlowLimitExceeded`。
- 上游编辑框里有「拉取模型」按钮，直接把探测到的列表填进模型输入框（保存后生效）。

> Agent Plan 只允许调用套餐内的模型（如 `ark-code-latest`），而且官方明确说明
> 文本生成/向量化模型不可用于 API 调用，在非 AI 工具里使用套餐 Base URL 和 key
> 可能被判定为滥用导致订阅停用。拿它当通用 LLM 网关前请先确认自己的用法在允许范围内。

关于额度：

- 用的是 `GetAFPUsage`，**只适用于个人版 Agent Plan**。企业版席位要换 `GetSeatAFPUsage`。
- 这个接口是管控面 API，只能用 IAM 的 AK/SK 走 Signature V4 签名，**推理用的 Ark API Key 调不了**。
- 返回的 `Quota` / `Used` 单位是 AFP 积分，不是 token，所以额度只用来判断「还能不能继续用」，不和自带用量统计混算。

---

## 调度逻辑

每个请求：

1. 校验下游 key（启用状态 / 过期 / rpm 滑窗 / 并发 / 当日请求数与 token）
2. 过滤上游：启用、支持该模型、不在冷却、并发槽有空、额度没见底
3. 打分：`优先级 + 负载 + 额度余量 + 健康度`（权重可在设置页调）
4. 取分数前 `topK` 名加权随机 —— 避免所有请求同时砸向同一个上游
5. 失败换号：只在**还没往客户端吐字节**时换，最多换 `maxAttempts` 个
6. 冷却：429 优先按 `retry-after` / `x-ratelimit-reset-*` / 响应体里的重试时间；拿不到就用兜底值。401/403 冷却 1 小时并标红。

**粘性会话**：用「下游 key + 首条 user 消息」算指纹，同一对话锁定同一个上游，把上游的 KV cache 吃满。指纹只是确定性优先，上游冷却或并发满时自动让位。

---

## 界面

- **仪表盘** —— 今日请求 / token / 错误率 / 首字延迟，最近 60 分钟流量，上游健康度；
  套餐额度按 5 小时 / 今日 / 本周 / 本月四个窗口展示已用、总量和重置倒计时
- **上游** —— 增删改查、测试连通性（打 `/models`，不花生成额度）、立即刷新额度、清除冷却
- **下游 Key** —— 增删改查、一键复制、按 key 限速限模型
- **请求日志** —— 按状态 / key / 上游过滤
- **设置** —— 冷却时长、轮询间隔、调度权重

---

## 部署注意

**单实例。** 冷却、并发槽、粘性会话、用量计数全在进程内存里，多实例会各算各的。不要用 PM2 cluster 或 k8s 多副本。

**流式响应必须关掉前置代理的缓冲**，否则 SSE 会被攒成一整块：

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_buffering off;          # 关键
    proxy_cache off;
    proxy_read_timeout 600s;      # 长回答别被掐断
    chunked_transfer_encoding on;
}
```

响应里已经带了 `X-Accel-Buffering: no`，nginx 会认。

---

## Docker

### docker compose（推荐）

```bash
cp .env.example .env      # 改掉 ADMIN_PASSWORD
docker compose up -d
docker compose logs -f
```

镜像默认从 ACR 拉。想用本地源码构建，把 `docker-compose.yml` 里的 `image:` 注释掉、放开 `build: .`。

### 或者直接 docker run

```bash
docker build -t ai-proxy .
docker run -d --name ai-proxy \
  -p 3000:3000 \
  -e ADMIN_PASSWORD='换成强密码' \
  -v ai-proxy-data:/data \
  --restart unless-stopped \
  ai-proxy
```

### 数据卷

`/data` 里是 `config.json`、`usage.json` 和请求明细，**必须挂卷**，否则重建容器配置就没了。

compose 默认用命名卷，文件在 docker 管理的卷里，查看和备份：

```bash
docker compose exec ai-proxy cat /data/config.json
docker run --rm -v ai-proxy-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/data.tgz -C /data .
```

想直接用编辑器改 `config.json`，改成绑定挂载：

```yaml
    volumes:
      - ./data:/data
```

镜像里以 uid 1001 运行，宿主机目录要先给权限，否则写不进去：

```bash
mkdir -p data && sudo chown 1001:1001 data
```

改完在管理台侧边栏点「重载配置」即可生效，不用重启。

镜像用 Next 的 standalone 产物，非 root 运行，自带 `HEALTHCHECK`（打 `/login`，不需要鉴权）。
单实例限制在容器里同样成立：不要 `--scale` 多副本，内存态会各算各的。

> `.dockerignore` 排除了 `data/`，这一步很关键：`next build` 会把项目里存在的 `data/`
> 追踪进 `.next/standalone`，构建上下文里要是有它，上游密钥就会被烤进镜像层。

前面挂 nginx 时记得关掉缓冲，见上面「部署注意」。

### GitHub Actions

`.github/workflows/docker.yml`，`git tag v0.2.0 && git push --tags` 触发构建并推送到阿里云 ACR：

| 触发方式 | 推送的 tag |
|---|---|
| 打 tag（`v*`） | `:0.2.0`（去掉 `v` 前缀）+ `:latest` |
| Actions 页面 Run workflow | `:<sha7>`，不动 latest |

需要先配好仓库 Secrets：`ACR_USERNAME` / `ACR_PASSWORD`（Settings > Secrets and variables > Actions）。
镜像名在 workflow 的 `env.IMAGE_NAME` 里改。

---

## 开发

```bash
bun run dev
bun run check     # 自检：签名/调度/冷却/SSE 计量，21 项断言
bun run mock      # 起一个本地模拟上游（默认 :8787），配合 dev 调转发
```

### 关键实现位置

| 文件 | 作用 |
|---|---|
| `lib/forward.ts` | 转发主流程、重试、429 冷却解析 |
| `lib/scheduler.ts` | 打分选号、并发槽、冷却、粘性会话 |
| `lib/stream.ts` | SSE 行缓冲 + usage 提取（处理 chunk 边界截断） |
| `lib/stats.ts` | 聚合计数、防抖落盘、JSONL 读写与清理 |
| `lib/quota/volcengine.ts` | Signature V4 签名 + `GetAFPUsage` |

---

## 没做的部分

- Anthropic `/v1/messages`、`/v1/responses`、WebSocket
- 用户系统 / 计费 / 充值
- 多实例与分布式锁
- 上游自动永久下架（只做冷却，不自动停用）
- 全文请求审计日志