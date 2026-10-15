# MCP setup guide

English | [简体中文](mcp.zh-CN.md)

Medivh provides a read-only MCP endpoint in its existing backend so agents can query billing details already collected in local SQLite. The default URL is `http://127.0.0.1:8788/mcp`. It uses Streamable HTTP with stateless JSON responses; no separate MCP process or port is required.

Queries do not contact Cloudflare, refresh bills, trigger collection, or send notifications. Data freshness matches the dashboard. When initial backfill is incomplete, agents should preserve the returned gaps and completeness information.

## Before you start

- Start Medivh and open Settings, normally at `http://127.0.0.1:8788/settings`. See the [README](../README.md) for deployment instructions.
- Use a client that supports **Streamable HTTP** and a custom `Authorization` header. This server does not provide a stdio launch command or a separate legacy SSE URL.
- Make sure the agent can reach Medivh. `127.0.0.1` refers to the machine or container running the client; a remote agent cannot use it to reach your computer. Compose publishes the service on the host loopback address by default. Remote access requires a reachable entry point.

## Enable MCP in Settings

1. Click the gear icon in the page header, then generate a token in the MCP section.
2. Copy the token and keep it securely, then click **Save settings** at the bottom of the page to activate it. The full value is available only during this page visit. After refreshing or leaving, it cannot be retrieved; generate a replacement if needed.
3. Once saving succeeds, enter the displayed connection URL and token in your agent's MCP client configuration.

Generating a token creates an unsaved draft. It does not write to the database or change current access. **Save settings** saves MCP, basic, and notification settings together and applies them without changing `.env` or restarting the service. Refreshing or leaving discards unsaved drafts. Saved settings persist in the database across restarts.

After regeneration, the old token remains valid and the new token is unusable until saving succeeds. Update connected clients after saving. Disabling MCP also requires saving; afterward `/mcp` returns `404`. To enable it again, generate and save a new token. A saved disabled state will not fall back to an existing `MCP_TOKEN` environment variable on restart. If settings validation fails, no changes are saved; correct the problem and retry.

### Regenerate, cancel, or disable

| Action                                | Before clicking Save settings                          | After a successful save                                   |
| ------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| Generate the first token              | The new token is pending; MCP remains disabled         | The new token becomes active                              |
| Regenerate                            | The old token remains valid; the new token is unusable | The new token becomes active; the old token stops working |
| Disable MCP                           | The current token remains valid                        | No token can access MCP                                   |
| Cancel MCP changes, refresh, or leave | Unsaved MCP changes are discarded                      | Previously saved settings are unaffected                  |

**Cancel MCP changes** discards only the MCP draft, without clearing other settings. A failed save keeps the draft for retry after you correct the reported problem. The database stores only a hash of the token, so saved settings cannot reveal its full value. Generate and save a replacement if you lose it.

Every MCP request must include `Authorization: Bearer <MCP_TOKEN>`. When MCP is enabled, missing or incorrect credentials return `401`. The MCP token **protects only `/mcp`**. The dashboard and `/api` routes, including token management, have no built-in login. For remote access, use HTTPS and configure authentication at the entry point.

### Optional environment variables

Existing deployments can continue using `.env`'s `MCP_TOKEN` until MCP settings have been saved. Generating a draft does not override it. Once a generated, regenerated, or disabled state is saved, the saved settings take precedence. If no token has been saved and the environment variable is empty, MCP stays disabled.

An environment token must contain at least 32 visible ASCII characters with no whitespace. Do not reuse `CLOUDFLARE_API_TOKEN`. You can generate a separate token with `openssl rand -hex 32`. Environment changes require a service restart or a Docker Compose redeployment.

`MCP_ALLOWED_ORIGINS` is an optional, independently configured list of exact origins, for example `https://agent.example.com,http://localhost:3000`. Paths, trailing slashes, and wildcards are not supported. By default, requests containing an `Origin` header are rejected; ordinary agent clients that omit it can connect. This allowlist only controls origin validation and does not provide browser CORS support. An unlisted origin returns `403`.

## Configure your client

Add an MCP server using these values:

| Field        | Value                                                                     |
| ------------ | ------------------------------------------------------------------------- |
| Name         | `medivh`, or a name of your choice                                        |
| Transport    | Streamable HTTP                                                           |
| URL          | The connection URL shown in Settings, such as `http://127.0.0.1:8788/mcp` |
| Header name  | `Authorization`                                                           |
| Header value | `Bearer <MCP_TOKEN>`, with one space after `Bearer`                       |

If the client has a dedicated Bearer Token field, it normally expects just the token; avoid adding `Bearer` twice. Save the configuration and reconnect or reload the MCP server using your client's controls.

The following is a generic JSON example. **Not every client uses these field names.** If your client provides URL, transport, and header inputs, use the table above instead.

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

Replace `<MCP_TOKEN>` with the token generated **and saved** in Settings, or the fallback environment token for an existing deployment. Remote clients must use the actual deployment URL. For local development, connect to the backend on port `8788`.

After connecting, list the tools. You should see the eight read-only tools below. Call `get_billing_summary` to verify access. A successful response containing billing-cycle or collection-status information confirms the connection; missing billing data alone does not mean the connection failed.

Example prompts for your agent:

- “Show this billing cycle's total, today's increase, and the last collection time.”
- “List costs by service and meter, and explain which data is incomplete.”
- “Show the cost breakdown for a day in this cycle, comparing official bills with local estimates.”
- “Show resource usage and estimated costs for a service, and identify the resources with the largest growth.”

Start with `get_billing_summary` for the cycle and data status, then use `list_billing_services` to discover exact `service` names and `meter` keys before requesting details or trends.

## Tool reference

All tools are read-only and support only the active billing cycle. Every tool except `get_billing_summary` accepts `offset` and `limit`, defaulting to `0` and `100`. The allowed `limit` range is `1`–`500`. Use `pagination.nextOffset` for the next page; `null` means there are no more pages.

| Tool                      | Parameters other than pagination                   | Result                                                                                       |
| ------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `get_billing_summary`     | None                                               | Active cycle, currency, totals, collection timestamps, and data gaps                         |
| `list_billing_services`   | Optional `service`                                 | Services and meters, usage, prices, allowances, estimates, and official costs                |
| `get_billing_history`     | Optional `startDate`, `endDate`                    | Daily history in ascending date order; both date bounds are inclusive                        |
| `get_daily_costs`         | Required `date`; optional `service`                | Meter usage, local and official costs, differences, and remaining allowances for a UTC date  |
| `get_service_cost_trend`  | Required `service`; optional `meter`, `resolution` | Cumulative service or meter costs; meter queries can also include cumulative usage           |
| `get_resource_usage`      | Required `service`, `meter`; optional `resolution` | Per-resource interval usage, window totals, actual resolution, and coverage warnings         |
| `get_resource_cost_trend` | Required `service`; optional `meter`, `resolution` | Estimated cumulative cost allocations by resource and unattributed costs                     |
| `get_daily_meter_trend`   | Required `date`, `service`, `meter`                | Ten-minute interval usage and cumulative estimated costs for one day, with shared pagination |

Use `YYYY-MM-DD` for `date`, `startDate`, and `endDate`. Use the exact service names and meter keys returned by `list_billing_services`.

`resolution` is either `daily` (default) or `ten-minute`. Service cost trends return daily history for this cycle or saved collection points, respectively. Resource usage and resource cost trends cover the current cycle or the most recent 48 hours, respectively. Some resource sources have hourly granularity; use the actual returned resolution rather than treating every point as a ten-minute sample.

Resource tools paginate only `points`; their resource lists and totals still cover the entire query window. `get_daily_meter_trend` applies the same pagination to both `usage.points` and `cost.points`.

## Interpreting costs

- Dates use UTC. `cycle.end` is exclusive: a cycle from `2026-10-01` to `2026-11-01` ends after October 31.
- Amounts use the returned `currency`, not cents. `totals.current` combines official charges through yesterday with today's local estimate. `totals.localCumulative` is an independent local cumulative estimate.
- `null` means unavailable, not zero. Preserve `complete`, `warnings`, `unavailableReason`, and missing-date information when explaining results.
- Service cost trends contain cumulative amounts; resource usage points contain interval quantities. In daily history, `dailyCostSource` distinguishes official charges from local estimates.
- Resource costs are local estimates allocated by usage, not official Cloudflare per-resource bills. `unattributedCost` retains costs that cannot be assigned to a resource.
- Out-of-cycle or future dates and unknown services or meters do not query other cycles. Depending on the tool, they may return empty results or `isError: true`; inspect the response.

## Verify with curl

Set the same active token in your terminal. Do not commit it to the repository.

```sh
export MCP_TOKEN='replace-with-the-token-generated-and-saved-in-settings'
```

Initialize with the supported `2025-11-25` protocol version:

```sh
curl -sS http://127.0.0.1:8788/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"medivh-curl","version":"1.0.0"}}}'
```

The endpoint is stateless; no session ID needs to be retained. Include the protocol version on subsequent requests:

```sh
# List tools and their input schemas.
curl -sS http://127.0.0.1:8788/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# Read the billing summary.
curl -sS http://127.0.0.1:8788/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_billing_summary","arguments":{}}}'

# Discover service and meter names; use nextOffset to fetch subsequent pages.
curl -sS http://127.0.0.1:8788/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_billing_services","arguments":{"offset":0,"limit":100}}}'
```

Successful queries return `structuredContent` and a text `content` entry containing the same JSON. The endpoint accepts only `POST`. Opening it in a browser address bar produces `405` when authenticated, or `401` without credentials, while MCP is enabled.

## Troubleshooting

| Symptom                                                  | What to check                                                                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection refused or timeout                            | Confirm the service is running and the URL and port are correct. A remote or containerized client cannot use `127.0.0.1` to reach the Medivh host; check entry-point and network reachability.    |
| `404`                                                    | MCP may be disabled or not yet activated. Check Settings, whether you clicked Save settings, and that the URL ends in `/mcp`.                                                                     |
| `401`                                                    | Confirm the token was saved and has not been replaced. Check the complete `Authorization: Bearer <MCP_TOKEN>` header. Do not use your Cloudflare API token.                                       |
| `403`                                                    | The client may send an unlisted `Origin`. Configure the exact value in `MCP_ALLOWED_ORIGINS` and redeploy. This setting does not enable CORS.                                                     |
| `405`                                                    | A browser address bar sends GET, but this endpoint handles POST. Use a Streamable HTTP client or the curl examples; do not configure legacy SSE.                                                  |
| Settings fail to save                                    | Correct the reported notification URL, budget threshold, or other field. All settings are saved together; validation failures do not switch the token, and the draft remains available for retry. |
| A newly generated token does not work                    | Click Save settings first. Until then, only the old token remains valid. Update the client after saving.                                                                                          |
| A tool returns `isError: true`, empty results, or `null` | Check collection timestamps, the active cycle, and completeness in the summary. Use dates in the current cycle and exact service/meter identifiers. MCP does not trigger backfill.                |
| Tools are listed but the client cannot parse results     | Confirm the client supports Streamable HTTP JSON responses and check the protocol version, `Content-Type`, and `Accept`. Use curl to distinguish server issues from client configuration issues.  |
