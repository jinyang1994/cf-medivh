# Cloudflare Medivh

一个可以自行部署的 Cloudflare 账单监控工具。

## 事前说明

本项目主要通过 **vibe coding** 完成，如果介意请不要使用。

这里的「实时账单」更准确地说是**近实时费用估算**。

Medivh 提供监控、核对和通知，**不会自动停止 Cloudflare 服务，也不是账单硬顶**。

## 现状

Cloudflare 的 [Billable Usage API](https://blog.cloudflare.com/billable-usage-api/) 按日更新，并不是实时计费接口。

并且Cloudflare的账单并不是在UTC零时准时更新。

对于日内的账单突然暴涨，我们很难发现，并且国人很少关注邮件。

这才导致网上的一些案例：

[![案例1](./images/310ce83c-7460-4cbc-ba26-a2959d67affc.png)](https://x.com/keking99/status/2106687001810677911?s=20)

[![案例2](./images/1adbab35-cbe7-4445-9bda-dd29967b7234.png)](https://x.com/shmily7/status/2107481028726251762?s=20)

所以我决定将自己的监控服务开源出来，大家按需使用。

## 原理和问题

核心思路很简单：

```text
截至昨日的官方累计费用 + 今日新增估算费用 ≈ 当前账期费用
```

公式很短，真正需要处理的是这些问题：

### P1. 官方账单不准时更新

就像上面说的一样，官方账单不会实时更新，这是我们会在UTC 0时后的每一轮中尝试同步官方账单，直到同步成功为止。

并且会复查最近三天的数据，以接收迟到或修订的费用。

如果昨日的官方数据还没齐，本地累计估算在数据完整时仍可单独查看。

### P2. 免费额度和固定费用，如何避免重复计算？

按账期共享的免费额度只扣一次，明确按日提供的免费额度则按日重置。今日增量通过「加入今日用量后的累计费用 − 加入前的累计费用」计算。

### P3. 官方接口的服务费用单价精度有缺失

官方API提供的单价有些会有精度上的缺失，积少成多后可能漂移的很厉害。

所以用量单价集中维护在[价目表](server/src/constants/pricing.ts)中，优点是计算后的预估差值偏差小，但 **缺点是不会自动跟随官方调价**。

每次采集保存采用的单价和价目表版本，方便后续核对；更新代码中的价格不会改写已有快照。

### P4. 程序中断或接口失败，会不会丢掉判断依据？

用量快照、每日对账结果和通知状态保存在本地 SQLite 中。重启后会尝试补齐历史缺失数据；

### P5. 7 天的 Workers Logs 历史缺口

因为Cloudflare只能查到7天内的Workers Logs用量数据。

这个我也没有太好的解决办法，如果你在账单周期内的7天后初次使用这个服务，补历史数据时这部分会有缺失。

但好在我们每次计算时使用的是官方总账单，所以这部分影响不是很大（如果你不是很在意的话）。

## 功能介绍

| 功能         | 说明                                                           |
| ------------ | -------------------------------------------------------------- |
| 当前账单     | 查看当前周期费用、今日增量、历史官方累计和本地累计估算         |
| 费用趋势     | 切换 10 分钟采集曲线与每日对账曲线，比较官方校正结果和本地估算 |
| 服务明细     | 按服务和计费项查看用量、单价、免费额度及费用                   |
| 每日核对     | 查看逐日累计费用与差值，保留官方修订记录和计算依据             |
| 飞书通知     | 每轮采集发送汇总；当天用量采集失败时发送失败通知               |
| 超限 Webhook | 当前账期费用超过自定义阈值时，向指定地址发送事件               |
| 本地持久化   | 保存历史数据、采集进度和待发通知，支持重启后继续采集           |

目前已接入 Workers（请求、CPU、Dynamic Workers）、Workers Logs、Workers Builds、Containers、Durable Objects、R2、Queues、D1 和 Workers KV 的相关计费项。

使用前需要了解几个边界：

- 当前按**单个 Cloudflare 账户、同一账期**核算，需要账户已获得 Billable Usage API 覆盖；不同账期或多币种的订阅暂不支持合并。
- 如果发现未接入的计费服务或缺失指标时，会提示数据不完整。
- Analytics 可能存在延迟或采样，估算与官方计费结果可能有差异。启动前超过保留期的数据无法完整恢复，例如当前实现会提示超过 。
- 正常调度为每 10 分钟一次，不保证在超限瞬间通知。

## 如何使用

### 1. 准备账户配置

将仓库下载到本地，在项目根目录创建配置文件：

```sh
# 仅首次执行；已有 .env 时直接编辑，避免覆盖现有配置
cp .env.example .env
```

至少填写以下两项：

```dotenv
CLOUDFLARE_API_TOKEN=你的_API_Token
CLOUDFLARE_ACCOUNT_ID=你的_Account_ID
```

在 Cloudflare 的 **My Profile → API Tokens** 中创建自定义 Token，将账户资源限定到需要监控的账户，并配置以下权限：

| 权限                                 | 用途                                                                                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Account > Billing > Read`           | 读取账单、账期和订阅信息，见[账单权限说明](https://developers.cloudflare.com/billing/understand/billing-permissions/)                                                                                                         |
| `Account > Account Analytics > Read` | 查询用量统计，见[GraphQL Token 指引](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)                                                                                  |
| `Workers Observability Write`        | 查询 Workers 日志数量；这是[日志查询接口](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)目前要求的权限，虽然本项目仅执行查询，也不能用只读权限替代 |

Token 仅在后端使用，不会返回给前端；不要把 `.env` 提交到仓库。

### 2. 启动服务

可选择 Docker Compose 或本地 Node.js，使用一种方式持续运行即可。

**Docker Compose**

安装 Docker 和 Compose 后，在项目根目录执行：

```sh
docker compose up -d --build --wait
```

打开 <http://127.0.0.1:8788>。镜像中会完成前后端构建，宿主机无需另外安装 Node.js。

```sh
# 查看状态和日志
docker compose ps
docker compose logs --tail 100 -f medivh

# 修改 .env 或更新代码后重新部署
docker compose up -d --build --wait
```

Compose 默认只绑定本机端口，数据保存在 `billing-data` 持久卷，重建容器后继续使用；`docker compose down -v` 会删除该卷。持续采集需要 Docker 引擎保持运行。

**本地 Node.js**

需要 **Node.js 24 或更新版本**。在项目根目录执行：

```sh
npm run setup
npm run build
npm start
```

同样访问 <http://127.0.0.1:8788>，并保持进程运行。修改 `.env` 后需要重启服务。

本地数据库默认位于 `data/billing.sqlite`，与 Docker 持久卷中的数据库彼此独立。两种部署方式切换时，如需延续历史记录和通知去重状态，应先停止原采集器，再迁移完整的 SQLite 一致备份。

首次启动会采集当前用量并补齐本账期历史，可能需要等待。页面每 30 秒读取一次已保存的数据，手动刷新页面不会触发额外采集；若一直显示待校正，可以查看页面中的失败原因、待同步日期和服务日志。

### 3. 配置项

| 配置                     | 说明                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`   | 必填，访问 Cloudflare API 的 Token                                               |
| `CLOUDFLARE_ACCOUNT_ID`  | 必填，要监控的账户 ID                                                            |
| `HOST`                   | 本地运行默认 `127.0.0.1`；Compose 在容器内固定为 `0.0.0.0`                       |
| `PORT`                   | 本地运行默认 `8788`；Compose 固定使用 `8788`                                     |
| `DATABASE_PATH`          | 本地默认 `./data/billing.sqlite`，相对路径以项目根目录为基准；Compose 使用持久卷 |
| `FEISHU_WEBHOOK_URL`     | 可选，飞书群自定义机器人的 Webhook；留空则关闭飞书通知                           |
| `FEISHU_SIGNING_SECRET`  | 可选，飞书机器人启用签名校验时填写，需同时配置 Webhook                           |
| `BUDGET_WEBHOOK_URL`     | 可选，接收账单超限事件的 HTTP/HTTPS 地址                                         |
| `BUDGET_THRESHOLD_CENTS` | 可选，正整数美分阈值；`30000` 表示 300 美元，需与超限 Webhook 同时配置           |

当前页面和 API 没有内置登录验证。默认配置用于本机访问，需要对外部署时请在入口配置访问认证。

### 4. 配置飞书通知（可选）

在目标群中添加自定义机器人，将其 Webhook 填入 `FEISHU_WEBHOOK_URL`；如果开启签名校验，再填写 `FEISHU_SIGNING_SECRET`。使用关键词校验时，可将关键词设为 `Cloudflare`。

启用后，每轮成功采集都会发送汇总，正常情况下每 10 分钟一条，**金额没有变化也会发送**。消息包含采集时间、账期、官方账单加估算、本地累计估算及当日增量；金额暂缺时显示待校正。飞书消息的采集时间使用北京时间，账期仍按 UTC。

当天用量采集失败时会发送失败原因和上次成功采集时间，同一 10 分钟时间槽内去重。消息发送失败会保存在队列中，后续采集时重试；已确认发送成功的消息不再发送。历史补采不会逐条发送汇总，启用通知也不会补发启用前的采集记录。

### 5. 配置账单超限 Webhook（可选）

这项功能独立于飞书，在 `.env` 中同时配置以下两项：

```dotenv
BUDGET_WEBHOOK_URL=https://example.com/hooks/billing
BUDGET_THRESHOLD_CENTS=30000
```

重启后，成功采集得到的「官方账单 + 预测」（`currentTotal`）**严格大于 300 美元**时触发，等于阈值时不触发。阈值使用整数美分，不接受小数或负数。两项均留空则禁用，只填一项会在启动时报错。

- 仅对 USD 账期生效；金额待校正、采集失败或历史补采不会触发，也不会改用本地累计估算判断。
- 每个账期只生成一条超限事件，保留首次超限时的金额、阈值和时间。成功发送后，同账期再次超限、重启或修改阈值都不会重发。
- 接收方返回 HTTP 2xx 才视为成功。单次请求超时为 10 秒，不跟随重定向；失败后在当前任务内间隔 1 秒持续重试，直到成功或服务停止。
- **持续重试会让当前采集任务保持运行，后续采集需要等待。** 已保存的数据仍可查看；重启后会继续发送未完成的事件。
- 请求携带 `Idempotency-Key`，接收方应按此键去重，避免响应丢失后的重试导致重复处理。

<details>
<summary>Webhook 请求示例</summary>

请求方式为 JSON POST，`Idempotency-Key` 与正文中的 `id` 一致：

```json
{
  "kind": "budget_exceeded",
  "id": "budget:<账期 ID 的 SHA-256>",
  "cycle": {
    "id": "2026-10-01:2026-11-01",
    "start": "2026-10-01",
    "end": "2026-11-01",
    "currency": "USD"
  },
  "observedAt": "2026-10-09T04:00:00.000Z",
  "metric": "currentTotal",
  "thresholdCents": 30000,
  "amountUsd": 301.25
}
```

`cycle.end` 是不包含当天的结束日期；上述账期最后一个计费日为 10 月 31 日。

</details>

### 6. 开发与手动采集

项目使用 Node.js、TypeScript、Koa 和 SQLite，前端使用 React、React Router、shadcn/ui 和 Recharts。

```sh
npm run dev          # 启动前后端开发服务
npm test             # 后端测试
npm run check        # 后端类型检查和前端构建
npm run format:check # 检查代码与文档格式

# 手动额外采集一次，也会触发已配置的通知
npm --prefix server run collect

# Docker 部署时的手动采集命令
docker compose exec medivh node server/dist/collect.js
```

开发模式访问 <http://127.0.0.1:5173>，前端将 API 请求代理到后端 `8788` 端口。后端提供 `GET /api/dashboard` 和 `GET /api/health`。

更多实现细节见[Cloudflare 数据与计费口径](docs/cloudflare-api.md)、[前端目录说明](web/README.md)和[用量价目表](server/src/constants/pricing.ts)。

## 最后的一些废话

### 为什么叫 Medivh

借了《魔兽》中麦迪文的名字：既是守护者，也带着预警者的意味。虽然这祸是这位守护者自己闯出来的。

希望这次他能守护好我们的钱包吧。

### 期待官方的功能

Cloudflare 在 [2026 年 10 月 2 日的官方更新](https://blog.cloudflare.com/enterprise-for-all-update/)中表示，正在开发费用硬顶（hard spending caps），计划于 **2026 年第四季度提供早期可用版本**。。

抓紧上吧，让大伙能睡个好觉。在此之前，先给自己的账单多加一道提醒。

### 为什么没有做停用

一些服务的停用功能很简单，但有些服务需要提前在业务逻辑中事先预埋（比如万恶的DO）。并且每个人处理的逻辑应该也会不同。

所以我在将项目独立出来时决定只提供监控和提醒，一键停用只暴露一个Webhook，让人家自行处理各自的业务场景（比如删卡跑路，狗头保命...）。

### 希望大家使用起来

我自己的使用场景有限，不同套餐、产品组合和账期边界还需要更多真实案例验证。欢迎提交 Issue 或 PR，尤其是计费差异、缺失的服务指标和采集异常。

### 我是谁？

我是 jinyang1994，这是我的 [X](https://x.com/jinyang1994)，欢迎交流。
