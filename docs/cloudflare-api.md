# Cloudflare 账单数据口径

核验日期：2026-10-08。以下为实现依据，账户响应和令牌不写入此文档。

## 周期和官方账单

- `GET /accounts/{account_id}/billable-usage/info` 返回 `covered` 和订阅的 `billing_cycle_anchor_timestamp`、`start_timestamp`。取消订阅才提供 `end_timestamp`。周期按 UTC 和订阅锚点确定；月底锚点在短月份钳制到月末，下一月恢复原来的日号。[Info API](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_info_v1/)
- `GET /accounts/{account_id}/billable-usage?from=YYYY-MM-DD&to=YYYY-MM-DD` 的查询范围必须包含订阅账期锚点。数据行由服务和计费时间区间组成；`ContractedCost` 是区间费用，`CumulatedContractedCost` 是账期累计，不能将每天的累计列相加。保存每天的 `ContractedCost` 及原始账单行。[Billable Usage API](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v1/)
- 官方账单接口目前每天更新，不能替代每 10 分钟的 Analytics 采样。[Cloudflare 发布说明](https://blog.cloudflare.com/billable-usage-api/)
- Billable Usage 只包含按量超额费用。固定订阅费来自当前有效 Subscription，单独加入一次。面板的账期跟随订阅，不跟随自然月；稀疏产品不是每天都有记录。[账单面板口径](https://developers.cloudflare.com/billing/manage/billable-usage/)
- `/billable/usage` V2 仍受限，官方说明 cost/pricing 尚未填充，因此不能代替 V1 费用来源。[V2 API](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v2/)

## 实时采样与累计费用

每次采样查询当天 UTC 00:00 到采样时间的完整窗口，保存当日累计值。重复采样替换当天汇总，而不是把每次累计值叠加。历史恢复和跨日补齐按天查询。保留每次快照及当时价格，便于检查迟到数据和价格变化。

10 分钟曲线使用独立保存的费用快照，时间轴按 UTC 10 分钟归槽，并保留实际采集时间。同一槽保留最新完整结果，缺失槽不插值，后续官方修订不回写过去的费用点。已有采集记录可一次性恢复：仅接受观测日期与用量日期相同的真实采集，并只使用该观测之前已经保存的用量与价格；不能证明的金额留空。恢复点明确标记来源，因为旧官方记录的抓取时间是轮次开始时间，恢复值不等同于当时页面金额的精确录像。

令 `F(q)` 为扣除账期免额、执行产品舍入规则后的费用函数；`Q(d)` 为周期起点至 d 日的累计量。当天费用为 `F(Q(d)) - F(Q(d-1))`。每月免额只扣一次；明确按日免额的免费计划按日重置。展示费用由已经校正的官方历史加当天本地增量组成；本地整周期累计另存用于比较，不能用官方金额反填本地累计来制造零误差。

跨服务来源失败、未识别计费产品或无法计价的非零用量，应保留已有快照并显示采样不完整。HTTP 200、空数组或账单尚未覆盖目标日，都不能单独证明官方零费用已出账。

## 价格来源与单位

用量价格的唯一来源是 [`server/src/constants/pricing.ts`](../server/src/constants/pricing.ts) 中手动维护的价目表。36 项指标分别配置单价、计费单位、免费额度、额度周期、取整规则，以及适用的 Free 套餐覆盖值。`unitPrice` 表示每 `unitSize` 个用量单位的美元价格；`includedQuantity` 与用量采用相同单位。参考文档链接只用于人工核对，采集时不访问价格 API 或 Markdown。

调价时修改对应条目，同时更新 `PRICE_CATALOG_VERSION`。每次用量快照保存实际采用的完整价格，以及 `raw.priceCatalogVersion` 和代码来源；已有快照不会因代码调价而改写。后续采样或历史补采使用当时运行的代码价目表，因此不能将新价自动解释为历史生效价。订阅固定费用仍以账户实际订阅信息为准，账期缓存同时保留 Workers 的 Free/Paid 套餐身份。

升级前的旧账期缓存若未保存套餐身份，需要成功读取一次订阅信息后才能确认用量价格；不能直接假设为 Paid。已保存套餐身份的同周期缓存不受临时账期查询失败影响。

采用静态价目表是为了避免价格接口精度和文档解析的不稳定性。先前实测 `GET /billing/rate_plans/{public_key}` 把 Workers 单次请求价格表示为 `0`，把 DO duration 每 GB-second 的费率表示为 `0.000013`，且各 component 的计价单位不统一。当前实现已移除这一接口的自动价格覆盖及 Markdown 表格解析。[Rate Plan API](https://developers.cloudflare.com/api/resources/billing/subresources/rate_plans/methods/get/)

| 指标            | 采样转换与计价注意事项                                                                                                                                                             | 官方来源                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers CPU     | `cpuTimeUs / 1000` 得到 CPU-ms；请求与 CPU 分开扣免额。内部平台错误请求不计费，服务绑定和静态资源也有特殊口径。                                                                    | [价格](https://developers.cloudflare.com/workers/platform/pricing/)、[指标](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/) |
| Containers      | 内存用 GiB-seconds，磁盘用十进制 GB-seconds，CPU 用 vCPU-seconds；出站流量按区域分别计价。内存和磁盘按已配置资源运行时间收费。                                                     | [Containers 价格](https://developers.cloudflare.com/containers/platform/pricing/)                                                                           |
| R2              | 标准存储按每天峰值折算 GB-month；不是日末大小，也不是小时平均。A/B 和存储向上取整到计费单位，低频存储没有标准免费额度，且有最低 30 天存储期。                                      | [R2 价格](https://developers.cloudflare.com/r2/pricing/)                                                                                                    |
| Durable Objects | compute duration 的 Analytics 单位已是 GB-seconds。入站 WebSocket 消息按 20:1 转成计费请求；出站消息免费。SQL storage 和旧 KV storage 是不同指标。Compute 超额以百万单位向上取整。 | [DO 价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)                                                                              |
| Queues          | 使用 `billableOperations`，不要将消息数简单乘三；重试和大于 64 KB 的消息会改变操作数。                                                                                             | [Queues 价格](https://developers.cloudflare.com/queues/platform/pricing/)                                                                                   |
| Dynamic Workers | 使用 `workersInvocationsByOwnerAndScriptGroups.uniq.distinctDynamicWorkerCount` 按日取数；同一 Worker 多日活跃会分别计数。                                                         | [Dynamic Workers 价格](https://developers.cloudflare.com/dynamic-workers/pricing/)                                                                          |
| Workers Builds  | paid 每月含 6000 分钟，额外每分钟 $0.005。                                                                                                                                         | [Builds 价格](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)                                                                   |
| D1              | 用 `rowsRead` / `rowsWritten`，不是查询数；存储为所有数据库合计。                                                                                                                  | [D1 价格](https://developers.cloudflare.com/d1/platform/pricing/)                                                                                           |
| KV              | 操作按 key 计费；存储为 GB-month。                                                                                                                                                 | [KV 价格](https://developers.cloudflare.com/kv/platform/pricing/)                                                                                           |

## 采样精度与历史恢复

R2 的 `userError` 操作不能全部排除：对本账户官方逐日记录核验，2026-09-25 的 4 次 HeadObject 与 13 次 GetObject（均为 userError）对应官方 B 类 17 次；2026-10-06 的 11 次失败 GetObject 对应官方 B 类 11 次。仅排除平台 internalError，保留失败读取的操作数，原始记录保存在本地数据库供复核。

Workers Analytics 最近几分钟可能有聚合延迟，因此午夜还需要重新获取前一日最终窗口；不能只采用午夜前最后一次快照。Workers 指标可查询过去三个月，单次最多一周。[Workers 指标保留期](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)

R2、D1、KV 的指标可查询最近 31 天。超过保留期且没有本地记录时，本地比较应标为不完整，不把空返回解释成零用量。[R2 Analytics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)、[D1 Analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)、[KV Analytics](https://developers.cloudflare.com/kv/observability/metrics-analytics/)

官方账单按不同产品可能存在不同延迟，也可能省略无活动日期。本地重试应区分目标日期尚未就绪、接口失败和已确认的零费用。官方和本地保留原始数据，不将 Analytics 的估算误差隐藏为已经精确对账。
