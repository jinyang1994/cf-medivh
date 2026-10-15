# MCP 接入操作指南

[English](mcp.md) | 简体中文

Medivh 在现有后端提供只读 MCP 端点，方便 Agent 查询本地 SQLite 中已采集的费用明细。地址默认为 `http://127.0.0.1:8788/mcp`，使用 Streamable HTTP、无状态 JSON 响应，无需单独启动 MCP 进程或增加端口。

查询不会请求 Cloudflare、刷新账单、触发采集或发送通知。数据更新时间与网页一致；首次补采尚未完成时，Agent 需要保留返回的数据缺口和完整性信息。

## 接入前准备

- Medivh 已启动，能够打开设置页面（默认 `http://127.0.0.1:8788/settings`）。首次部署步骤见 [README](../README.zh-CN.md)。
- 客户端支持 **Streamable HTTP** 和自定义 `Authorization` 请求头。本服务不提供 stdio 启动命令或旧式独立 SSE 地址。
- Agent 能访问 Medivh 的地址。`127.0.0.1` 指向运行客户端的机器或容器，远程 Agent 不能用它访问你电脑上的服务。Compose 默认只发布到宿主机回环地址；远程访问需要先配置可达的入口。

## 在设置页面启用

1. 点击页面右上角齿轮进入设置，在 MCP 区域生成 Token。
2. 复制并妥善保管生成的 Token，然后点击页面底部的“保存设置”使其生效。完整值仅在本次页面访问中显示，刷新或离开页面后无法再次查看；丢失时可以重新生成。
3. 保存成功后，将页面显示的连接地址和 Token 填入 Agent 的 MCP 客户端配置。

生成 Token 只创建待保存的草稿，不会写入数据库或改变当前访问权限。点击“保存设置”后，MCP 配置与基础、通知设置一起保存并生效，无需修改 `.env` 或重启。刷新或离开页面会丢弃未保存的草稿；已保存配置会随数据库持久保存，重启后继续生效。

重新生成后，保存前旧 Token 继续有效，新 Token 尚不可用；保存成功后旧 Token 才失效，需要同步更新已连接的客户端。停用也需要点击“保存设置”才撤销 MCP 访问，此后 `/mcp` 返回 `404`；再次使用时重新生成并保存 Token。即使 `.env` 中已有 `MCP_TOKEN`，保存停用配置后也不会在重启时自动恢复。设置校验失败时不会保存任何更改，可以修正后重试。

### 重新生成、取消和停用

| 操作                      | 点击“保存设置”之前           | 保存成功之后           |
| ------------------------- | ---------------------------- | ---------------------- |
| 首次生成                  | 新密钥待保存，MCP 仍未启用   | 新密钥生效             |
| 重新生成                  | 旧密钥继续有效，新密钥不可用 | 新密钥生效，旧密钥失效 |
| 停用 MCP                  | 当前密钥继续有效             | 所有密钥无法访问 MCP   |
| 取消 MCP 更改、刷新或离开 | 丢弃未保存的 MCP 更改        | 已保存配置不受影响     |

“取消 MCP 更改”只撤回 MCP 草稿，不会清空其他设置。保存失败时先修正页面提示的问题再重试，草稿会保留。密钥只以哈希形式保存到数据库，无法从已保存配置中取回完整值；遗失时需要重新生成并保存。

每次 MCP 请求都必须携带 `Authorization: Bearer <MCP_TOKEN>`，缺失或错误返回 `401`。MCP Token **只保护 `/mcp`**；网页和 `/api` 路由（包括 Token 管理）没有内置登录验证。通过远程入口访问时，应使用 HTTPS 并在入口配置访问认证。

### 可选的环境变量

已有部署可以继续使用 `.env` 中的 `MCP_TOKEN`，但它只在尚未保存 MCP 页面配置时生效。页面生成、重置或停用并保存后，均以页面配置为准。首次使用时，页面未保存 Token 且环境变量为空，则 MCP 保持关闭。

环境变量密钥至少需要 32 个可见 ASCII 字符，不得包含空白；不要复用 `CLOUDFLARE_API_TOKEN`。可用 `openssl rand -hex 32` 生成独立密钥。修改环境变量需要重启服务；Docker Compose 需要重新部署。

`MCP_ALLOWED_ORIGINS` 可独立配置，是可选的 Origin 精确允许列表，例如 `https://agent.example.com,http://localhost:3000`，不支持路径、尾部斜杠或通配符。默认拒绝所有带 `Origin` 请求头的请求；不发送 `Origin` 的普通 Agent 客户端可正常连接。配置允许列表只控制 Origin 校验，不提供浏览器跨域访问所需的 CORS 支持。未允许的 Origin 返回 `403`。

## 客户端配置

在客户端的 MCP 服务器配置中添加以下信息：

| 项目       | 值                                                     |
| ---------- | ------------------------------------------------------ |
| 名称       | `medivh`（可自定义）                                   |
| 传输方式   | Streamable HTTP                                        |
| URL        | 设置页显示的连接地址，例如 `http://127.0.0.1:8788/mcp` |
| 请求头名称 | `Authorization`                                        |
| 请求头值   | `Bearer <MCP_TOKEN>`，`Bearer` 后有一个空格            |

如果客户端有单独的 Bearer Token 输入框，通常只填写密钥本身，避免重复添加 `Bearer`。按客户端提供的方式保存配置、重新连接或重新加载 MCP 服务器。

下面是通用 JSON 配置示例，**不是所有客户端都使用这套字段**；如客户端提供 URL、传输方式和请求头输入框，直接按上表填写：

```json
{
  "mcpServers": {
    "medivh": {
      "type": "http",
      "url": "http://127.0.0.1:8788/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}
```

将 `<MCP_TOKEN>` 替换为设置页面生成并保存的 Token（兼容旧部署时也可使用 `.env` 中的密钥）。远程客户端应使用实际部署地址；本机开发模式也连接后端 `8788` 端口。

连接后先列出工具，应能看到下文的 8 个只读工具，再调用 `get_billing_summary` 验证。成功返回账期或数据状态即表示接入正常；没有费用数据不代表连接失败。

可让 Agent 执行这些查询：

- “查看当前账期费用、今天新增费用和最后采集时间。”
- “列出各服务和计费项的费用，说明哪些数据尚未完整。”
- “查看本账期某一天的费用明细，比较官方账单与本地估算。”
- “查看某项服务的资源用量和估算费用，找出增长最多的资源。”

建议先调用 `get_billing_summary` 获取账期和数据状态，再调用 `list_billing_services` 获取精确的 `service` 名称和 `meter` 键，然后查询趋势或明细。

## 工具

所有工具均只读，仅支持当前活动账期。除 `get_billing_summary` 外，均支持 `offset` 和 `limit` 分页，默认分别为 `0` 和 `100`，`limit` 范围为 `1` 至 `500`。结果中的 `pagination.nextOffset` 为下一页起点；为 `null` 表示没有下一页。

| 工具                      | 参数（除分页外）                           | 内容                                                          |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| `get_billing_summary`     | 无                                         | 当前账期、币种、费用汇总、采集时间及数据缺口                  |
| `list_billing_services`   | 可选 `service`                             | 服务和计费项名称、用量、单价、免费额度、估算与官方费用        |
| `get_billing_history`     | 可选 `startDate`、`endDate`                | 本账期逐日历史，按日期升序排列；两个日期边界均包含当天        |
| `get_daily_costs`         | 必填 `date`；可选 `service`                | 指定 UTC 日期的计费项用量、本地费用、官方费用、差值和剩余额度 |
| `get_service_cost_trend`  | 必填 `service`；可选 `meter`、`resolution` | 服务或计费项的累计费用趋势；指定计费项时还可返回累计用量      |
| `get_resource_usage`      | 必填 `service`、`meter`；可选 `resolution` | 按资源拆分的区间用量、窗口合计、实际时间粒度与覆盖警告        |
| `get_resource_cost_trend` | 必填 `service`；可选 `meter`、`resolution` | 资源累计费用分摊估算及未归属费用                              |
| `get_daily_meter_trend`   | 必填 `date`、`service`、`meter`            | 单日 10 分钟区间用量和当日累计估算费用；两组点使用相同分页    |

`date`、`startDate`、`endDate` 使用 `YYYY-MM-DD` 格式。`service` 与 `meter` 必须使用 `list_billing_services` 返回的精确名称和键。

`resolution` 可为 `daily`（默认）或 `ten-minute`：服务费用趋势分别返回本账期逐日历史或已保存的采集时间点；资源用量与资源费用趋势分别覆盖本账期或最近 48 小时。部分资源数据源仅支持小时粒度，应使用结果中的实际粒度，不能将所有点都解读为 10 分钟样本。

资源工具只对 `points` 分页，资源列表及其合计仍覆盖完整查询窗口，不随当前页缩小。`get_daily_meter_trend` 同时对 `usage.points` 与 `cost.points` 分页。

## 费用口径

- 所有日期按 UTC 解释。`cycle.end` 是排他结束日期，例如 `2026-10-01` 至 `2026-11-01` 的账期最后一天为 10 月 31 日。
- 金额单位为返回的 `currency`，不是美分。`totals.current` 是截至昨日的官方费用加今日本地估算；`totals.localCumulative` 是独立的本地累计估算。
- `null` 表示数据暂不可用，不能当作 `0`。解释结果时保留 `complete`、`warnings`、`unavailableReason` 及缺失日期等信息。
- 服务费用趋势为累计金额，资源用量点为区间用量；每日历史中的 `dailyCostSource` 区分当日费用来自官方账单还是本地估算。
- 资源费用是按用量分摊的本地估算，不是 Cloudflare 官方逐资源账单。`unattributedCost` 保留无法归属到具体资源的费用。
- 超出当前活动账期、未来日期、未知服务或计费项不会查询其他账期；对应工具可能返回空集合或 `isError: true`，应按返回内容处理。

## 使用 curl 验证

先在当前终端设置与服务端相同的密钥（不要提交到仓库）：

```sh
export MCP_TOKEN='替换为设置页面生成并保存的 Token'
```

初始化请求使用兼容的 `2025-11-25` 协议版本：

```sh
curl -sS http://127.0.0.1:8788/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"medivh-curl","version":"1.0.0"}}}'
```

端点无状态，无需保存会话 ID。后续请求携带协议版本：

```sh
# 列出工具及其输入 schema
curl -sS http://127.0.0.1:8788/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 查询当前费用汇总
curl -sS http://127.0.0.1:8788/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_billing_summary","arguments":{}}}'

# 获取服务与计费项名称；按 nextOffset 继续翻页
curl -sS http://127.0.0.1:8788/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_billing_services","arguments":{"offset":0,"limit":100}}}'
```

查询成功时，结果同时提供 `structuredContent` 和包含同一份 JSON 的文本 `content`。端点仅接受 `POST`；直接在浏览器地址栏访问会得到 `405`（未认证时为 `401`）。

## 常见问题

| 现象                                      | 检查方法                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 连接被拒绝或超时                          | 确认服务已启动、地址和端口正确。远程或容器内客户端不能把 `127.0.0.1` 当作 Medivh 宿主机；检查入口和网络是否可达。                     |
| `404`                                     | MCP 可能尚未启用或已保存停用配置。检查设置页状态、是否点击了“保存设置”，以及 URL 是否为 `/mcp`。                                      |
| `401`                                     | 检查 Token 是否已经保存、是否被重新生成替换，以及 `Authorization: Bearer <MCP_TOKEN>` 是否完整；不要使用 Cloudflare API Token。       |
| `403`                                     | 客户端可能发送了未允许的 `Origin`。按上文精确配置 `MCP_ALLOWED_ORIGINS`，然后重新部署；该配置不等同于启用 CORS。                      |
| `405`                                     | 地址栏访问使用 GET，而本端点只处理 POST。使用 Streamable HTTP 客户端或上面的 curl 请求；不要配置成旧式 SSE。                          |
| 保存设置失败                              | 根据页面错误检查通知地址、预算阈值等字段。全部设置一起保存，校验失败不会切换密钥，草稿仍可重试。                                      |
| 生成后新 Token 无法使用                   | 先点击“保存设置”；保存前只能使用旧 Token。保存后再更新客户端配置。                                                                    |
| 工具返回 `isError: true`、空结果或 `null` | 先查费用汇总中的采集时间、账期和完整性；确认日期在当前账期内，服务和计费项使用工具返回的精确值。MCP 不会触发补采。                    |
| 工具列表正确但客户端解析失败              | 确认客户端支持 Streamable HTTP 的 JSON 响应，检查协议版本、`Content-Type` 和 `Accept`。可先运行 curl 示例区分服务端与客户端配置问题。 |
