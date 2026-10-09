# Cloudflare 账单

Node.js + TypeScript + Koa + SQLite 后端，React + React Router + shadcn/ui 前端。

## 运行

需要 Node.js 24 或更新版本。

```sh
npm run setup
cp .env.example .env
# 填写 .env 中的 Cloudflare API token 和 Account ID
npm run build
npm start
```

打开 http://127.0.0.1:8788 。本机已配置的 `.env` 不要被示例文件覆盖。

开发模式：`npm run dev`，前端使用 http://127.0.0.1:5173 ，代理后端 8788。

```sh
npm test
npm run check
npm run format
npm run format:check
npm --prefix server run collect
```

需要长期持续采集时保持 Node 进程运行，或使用 Docker Compose：

```sh
docker compose up -d --build --wait
```

Compose 仅绑定本机 8788 端口，数据库位于持久卷 `billing-data`（本项目默认卷名为 `cf-medivh_billing-data`），重建容器后继续使用。服务配置了健康检查、`unless-stopped` 重启策略和 2 分钟的优雅停机时间。持续采集需要 Docker Desktop 保持运行。

`.env` 通过 Compose 注入容器，不会打包进镜像。修改配置后重新执行上面的命令即可。容器以普通用户运行，前后端均已在镜像内构建。

宿主机数据库默认在 `data/billing.sqlite`，与容器数据库彼此独立。首次迁移时应先停止宿主机采集器，再把 SQLite 一致备份导入持久卷，同时保留 `state` 和 `notification_outbox`，以延续采集进度和消息去重。切换后只运行容器中的采集器。

```sh
docker compose ps
docker compose logs --tail 100 -f medivh
docker compose restart medivh
# 如需手动额外采集一次（也会发送飞书消息）
docker compose exec medivh node server/dist/collect.js
```

## 后端结构

`server/src` 按职责组织，入口文件只负责装配和启动：

| 位置                     | 职责                        | 主要文件                                                                                                                   |
| ------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`、`collect.ts` | HTTP 服务启动、手动采集入口 | 连接配置、数据库、采集器与通知发送器                                                                                       |
| `app.ts`                 | Koa 应用装配                | 注册中间件、API 路由和静态页面                                                                                             |
| `routes/`                | HTTP 接口与响应             | 健康检查、账单面板、API 404                                                                                                |
| `middleware/`            | HTTP 通用行为               | 错误处理、响应头、SPA 页面回退                                                                                             |
| `services/`              | 账单业务逻辑                | `collector.ts` 采集调度；`calculation.ts` 费用计算；`dashboard.ts` 面板汇总；`timeline.ts` 历史曲线；`pricing.ts` 价格查询 |
| `resources/`             | 外部资源接入与数据适配      | `cloudflare/provider.ts` API 调用；`cloudflare/analytics.ts` 查询和数据归一化；`feishu.ts` 群机器人通知                    |
| `repositories/`          | 数据持久化                  | `billing-store.ts` 集中管理 SQLite、采集租约、历史记录和通知队列                                                           |
| `constants/`             | 维护静态业务常量            | `pricing.ts` 价目表、免费额度和版本                                                                                        |
| `utils/`                 | 通用工具函数                | `dates.ts` UTC 日期与十分钟时间槽                                                                                          |
| `config/`                | 环境变量读取与校验          | `index.ts` 定位项目根目录并读取配置                                                                                        |
| `types/`                 | 共享数据契约                | `index.ts` 账期、用量、账单、通知和面板类型                                                                                |

新增接口放在 `routes`，账单规则放在 `services`，第三方协议适配放在 `resources`，SQL 操作放在 `repositories`。测试位于 `server/test`，覆盖各层对外行为。

前后端的项目内导入统一使用 `@/` 指向各自的 `src`，省略 `.ts`、`.tsx` 和 `.js` 后缀，例如 `@/services/collector`、`@/config`。后端测试也使用同一别名。后端开发与测试由 `tsx` 读取路径配置；生产构建先运行 `tsc`，再由 `tsc-alias` 将别名转换为带 `.js` 后缀的相对路径，产物可直接使用 Node 运行。

## 前端结构

`web/src/App.tsx` 只装配路由；三个账单页面分别放在 `pages/billing`。`layouts` 管理公共页头、导航和同步状态；`components/billing` 放图表、指标卡和历史表格；`components/ui` 保留 shadcn 组件。`services` 负责接口请求，`hooks` 负责轮询和页面数据读取，`constants` 管理导航配置，`utils` 放格式化与展示数据汇总，`types` 对接共享数据类型。

文件目录和扩展位置见 [前端 README](web/README.md)。

## 采集与金额

- 从 Cloudflare `billable-usage/info` 和 `subscriptions` 读取实际账期，以 UTC 日期保存，结束日期不包含当天。页面显示最后一个计费日。
- 账期查询失败时，如果已保存账期仍覆盖当前 UTC 日期，就静默沿用并在下一轮重试；跨期或没有可用账期时才显示账期错误。用量和官方汇总的采集失败仍单独提示。
- 启动时采集，之后在 UTC 每小时 `00/10/20/30/40/50` 分采集当天累计用量，并保存所用价目表版本和单价。保留每次快照；每天最新累计量参与计算，避免重复累加。
- 周期累计图默认每 10 分钟一个点，展示该次采集的「历史官方 + 当日实时」和本地累计，也可切换每日对账曲线。同一时间段重复采集保留最新成功值，缺少记录的时间段留空；不会用每日汇总插值生成启动前的实时点。
- 用量单价、计费单位和免费额度统一在 [`server/src/constants/pricing.ts`](server/src/constants/pricing.ts) 维护，不抓取价格 API 或 Markdown。调价时修改对应条目并更新 `PRICE_CATALOG_VERSION`；旧快照保留原单价。订阅固定费用仍从账户实际订阅信息读取。
- 每天 UTC 零点后取账期开始至前一天的官方累计费用。空响应、请求失败、未覆盖目标日期或缺少可能收费的服务数据都会重试。
- 历史缺失数据自动回填；最近三天复查官方迟到或修订的数据。首次对账和修订版都保留本地用量、价格、观察时间及官方原始记录。
- **当前周期费用 = 截至昨天的官方费用 + 当天本地实时增量。** 官方历史暂未齐全时显示待校正，不把缺失数据当作零。采集失败保留最近一次成功快照并显示截至时间和错误。
- Workers 固定订阅费按周期计入一次，单独展示。Cloudflare 的 Billable Usage 页面仅显示用量费用，核对时需剔除固定费。
- 免费额度在同一账期内共享；当天增量等于加入今天用量前后的计费差额。存储量先换算为计费时长，R2 使用每日峰值，按各产品规则处理计费单位取整。

已接入当前账户使用的 Workers（请求、CPU、Dynamic Workers）、Workers Logs、Builds、Containers、Durable Objects、R2、Queues，并支持 D1、Workers KV。发现未支持的计费产品或缺失指标时明确标记不完整，避免静默漏账。

GraphQL 是近实时统计，可能采样、延迟，与官方计费四舍五入也有细微差别。本地历史可从服务的 analytics 回填，但 Workers Logs 仅保留七天；程序启动前更早的日志量无法恢复，历史估算会明确提示。程序运行后保存的快照不受云端保留期影响。官方每日校正金额不依赖日志回填。

## 数据与配置

| 配置                    | 用途                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | 只在后端使用；需要账户账单/订阅读取、Account Analytics 读取及 Workers Observability 查询权限 |
| `CLOUDFLARE_ACCOUNT_ID` | 账户 ID                                                                                      |
| `HOST`                  | 默认 `127.0.0.1`                                                                             |
| `PORT`                  | 默认 `8788`                                                                                  |
| `DATABASE_PATH`         | 相对于项目根目录，默认 `data/billing.sqlite`                                                 |
| `FEISHU_WEBHOOK_URL`    | 可选，飞书群自定义机器人的 Webhook；留空则关闭通知                                           |
| `FEISHU_SIGNING_SECRET` | 可选，群机器人启用签名校验时填写对应密钥                                                     |

SQLite 表：`cycles`、`usage_snapshots`、`daily_usage`、`billing_points`、`reconciliations`、`reconciliation_versions`、`job_errors`、`state`、`collector_lease`、`notification_outbox`。原始证据仅保存在后端数据库，前端接口不返回 token 或原始请求数据。

## 飞书群通知

在目标群的设置中添加自定义机器人，将 Webhook 填到本地 `.env` 的 `FEISHU_WEBHOOK_URL`。若启用了签名校验，同时填写 `FEISHU_SIGNING_SECRET`；若使用关键词校验，关键词可设为 `Cloudflare`。修改后重启服务。机器人配置见[飞书官方指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)。

启用后，每轮成功采集当天用量并保存费用点后发送一条汇总，默认每 10 分钟一次；金额不变也会发送。手动运行 `npm --prefix server run collect` 成功时也会通知。历史补采、前端刷新和同一时间槽内的重复启动不会各自触发额外消息。消息包含采集北京时间、UTC 账期、官方账单 + 预测、本地数据 + 预测、当日增量和昨日官方累计；暂缺金额显示待校正。

若本轮未能获取完整、有效的当天数据（请求失败、部分服务失败，或无法确认当前账期），会发送一条失败通知，包含本轮北京时间、失败原因和上次成功采集时间；不把旧金额冒充本轮新结果。同一个 UTC 10 分钟槽内只产生一条失败通知，下一轮仍失败则再次通知。当前账期内使用缓存后采集成功，仍只发正常汇总；当天采集成功但历史补采失败时，沿用正常汇总中的失败提示。

待发送消息保存到 SQLite，成功通知使用采集快照 ID 去重，失败通知使用 10 分钟时间槽去重；已确认发送成功的消息不再重复发送。发送失败不改变账单采集状态，页面会显示单独的通知失败提示，下一轮采集重试原消息（保留原采集时间、金额或失败原因）。未配置 Webhook 时不产生通知队列，之后启用也不会补发启用前的采集记录。

接口：`GET /api/dashboard`、`GET /api/health`。页面每 30 秒读取最新数据库结果；该刷新不会触发 Cloudflare 额外采集。

shadcn/ui 通过官方 `npx shadcn@latest init` 和 `npx shadcn@latest add` 安装，生成的组件及主题样式保持原样。

Prettier 在项目根目录统一配置，`npm run format` 格式化项目代码和文档，`npm run format:check` 检查格式。依赖、构建产物、本地数据、锁文件及 shadcn 官方生成组件和主题均已排除。

Cloudflare API、精度及计费来源见 [docs/cloudflare-api.md](docs/cloudflare-api.md)。
