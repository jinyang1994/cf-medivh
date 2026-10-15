import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Store } from '@/repositories/billing-store';
import type { Collector } from '@/services/collector';
import { dashboard } from '@/services/dashboard';
import { dailyServices } from '@/services/daily-services';
import { dailyMeterTrend } from '@/services/daily-meter-trend';
import { serviceTrend } from '@/services/service-trend';
import { resourceTrend } from '@/services/resource-trend';
import { resourceCostTrend } from '@/services/resource-cost-trend';
import { validDate } from '@/utils/dates';

const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0);
const service = identifier.describe('Exact service name returned by list_billing_services.');
const meter = identifier.describe('Exact key returned by list_billing_services.');
const date = z.string().refine(validDate, 'Expected a valid UTC date in YYYY-MM-DD format.');
const resolution = z.enum(['daily', 'ten-minute']).default('daily');
const paging = {
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(500).default(100),
};
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function page<T>(rows: T[], offset: number, limit: number) {
  return {
    rows: rows.slice(offset, offset + limit),
    pagination: {
      offset,
      limit,
      total: rows.length,
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    },
  };
}

function result(value: object): CallToolResult {
  // Both representations carry the same JSON, including explicit nulls for missing data.
  const structuredContent = { ...value };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent };
}

function unavailable(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function query(read: () => CallToolResult): CallToolResult {
  try {
    return read();
  } catch {
    // The SDK otherwise returns thrown error messages, which may include database internals.
    return unavailable('Billing data is temporarily unavailable. Check the server and retry.');
  }
}

/** Fresh protocol instance per HTTP request; all tools share the application's saved data. */
export function createBillingMcpServer(store: Store, collector: Collector): McpServer {
  const server = new McpServer(
    { name: 'cf-medivh', version: '1.0.0' },
    {
      instructions:
        'Read-only Cloudflare billing queries over locally collected data. Start with ' +
        'get_billing_summary and list_billing_services to discover the active cycle and exact ' +
        'service/meter names. Only the active billing cycle is supported. Dates are UTC; ' +
        'cycle.end is exclusive. Monetary values use the stated currency, not cents. ' +
        'null means unavailable, never zero. Current totals combine official historical charges ' +
        "and today's local estimate. Resource costs are estimated allocations, not official " +
        'per-resource bills. Trend costs are cumulative; resource usage points are interval ' +
        'quantities. Honor completeness, warnings and unavailableReason. Queries never refresh ' +
        'Cloudflare data. Use pagination.nextOffset to read remaining rows.',
    },
  );

  server.registerTool(
    'get_billing_summary',
    {
      description:
        'Read active billing cycle, currency, totals, freshness and collection gaps. ' +
        'current = official charges through yesterday + today local estimate; ' +
        'localCumulative is independently estimated. Missing amounts remain null.',
      inputSchema: z.strictObject({}),
      annotations,
    },
    () =>
      query(() => {
        const now = collector.clock();
        const view = dashboard(store, collector, now);
        const { errors, warnings, ...collection } = view.collection;
        const notificationWarnings = new Set(store.notificationErrors());
        return result({
          queriedAt: now.toISOString(),
          timezone: 'UTC',
          cycle: view.cycle,
          asOf: view.asOf,
          today: view.today,
          currency: view.currency,
          totals: view.totals,
          warnings: warnings.filter((warning) => !notificationWarnings.has(warning)),
          // Notification and provider diagnostics can contain operational details; expose counts.
          collection: { ...collection, errorCount: errors.length, warningCount: warnings.length },
        });
      }),
  );

  server.registerTool(
    'list_billing_services',
    {
      description:
        'Discover exact service names and meter keys, prices, allowances, cumulative/today usage ' +
        'and estimated/official costs. Optionally filter by exact service name. ' +
        'cost/todayCost are local estimates; consult complete before interpreting partial totals.',
      inputSchema: z.strictObject({ service: service.optional(), ...paging }),
      annotations,
    },
    ({ service, offset, limit }) =>
      query(() => {
        const view = dashboard(store, collector, collector.clock());
        const rows = view.services.filter(
          (row) => service === undefined || row.service === service,
        );
        const selected = page(rows, offset, limit);
        return result({
          cycle: view.cycle,
          currency: view.currency,
          asOf: view.asOf,
          complete: view.totals.complete,
          missingUsageDates: view.collection.missingUsageDates,
          services: selected.rows,
          pagination: selected.pagination,
        });
      }),
  );

  server.registerTool(
    'get_billing_history',
    {
      description:
        'Read daily billing history in the active cycle, oldest first. startDate/endDate are ' +
        'inclusive UTC dates. dailyCostSource distinguishes official versus estimated daily ' +
        'costs; officialTotal/localTotal are cumulative cycle amounts.',
      inputSchema: z
        .strictObject({ startDate: date.optional(), endDate: date.optional(), ...paging })
        .refine(
          ({ startDate, endDate }) => !startDate || !endDate || startDate <= endDate,
          'startDate must not be after endDate.',
        ),
      annotations,
    },
    ({ startDate, endDate, offset, limit }) =>
      query(() => {
        const view = dashboard(store, collector, collector.clock());
        const selected = page(
          view.history.filter(
            (row) => (!startDate || row.date >= startDate) && (!endDate || row.date <= endDate),
          ),
          offset,
          limit,
        );
        return result({
          cycle: view.cycle,
          currency: view.currency,
          history: selected.rows,
          pagination: selected.pagination,
        });
      }),
  );

  server.registerTool(
    'get_daily_costs',
    {
      description:
        "Read one UTC day's per-meter usage, local cost, official cost, differences and remaining " +
        'allowance in the active cycle. Optional exact service filter. Missing data stays null.',
      inputSchema: z.strictObject({ date, service: service.optional(), ...paging }),
      annotations,
    },
    ({ date, service, offset, limit }) =>
      query(() => {
        const detail = dailyServices(store, date, collector.clock());
        if (!detail)
          return unavailable(
            'No active cycle, or date is outside the active cycle or in the future.',
          );
        const selected = page(
          detail.services.filter((row) => service === undefined || row.service === service),
          offset,
          limit,
        );
        return result({ ...detail, services: selected.rows, pagination: selected.pagination });
      }),
  );

  server.registerTool(
    'get_service_cost_trend',
    {
      description:
        'Read cumulative local/official charges for a service or one meter, oldest first. ' +
        'daily returns cycle daily history; ten-minute returns saved observation slots. ' +
        'quantity is cumulative and only available for a single meter.',
      inputSchema: z.strictObject({ service, meter: meter.optional(), resolution, ...paging }),
      annotations,
    },
    ({ service, meter, resolution, offset, limit }) =>
      query(() => {
        const trend = serviceTrend(store, service, meter ?? null, collector.clock());
        if (!trend) return unavailable('Service or meter not found. Use list_billing_services.');
        const { history, timeline, ...metadata } = trend;
        const selected = page(resolution === 'daily' ? history : timeline, offset, limit);
        return result({
          ...metadata,
          resolution,
          points: selected.rows,
          pagination: selected.pagination,
        });
      }),
  );

  server.registerTool(
    'get_resource_usage',
    {
      description:
        'Read saved per-resource interval usage for a service meter. daily covers the active ' +
        'cycle; ten-minute covers the latest 48 hours and may return hourly samples when that ' +
        'is all the provider supports. Preserve actual resolution and coverage warnings. ' +
        'Resource totals cover the full returned window, not only the current page.',
      inputSchema: z.strictObject({ service, meter, resolution, ...paging }),
      annotations,
    },
    ({ service, meter, resolution, offset, limit }) =>
      query(() => {
        const trend = resourceTrend(store, collector, service, meter, resolution);
        if (!trend) return unavailable('Service or meter not found. Use list_billing_services.');
        const selected = page(trend.points, offset, limit);
        return result({ ...trend, points: selected.rows, pagination: selected.pagination });
      }),
  );

  server.registerTool(
    'get_resource_cost_trend',
    {
      description:
        'Read cumulative estimated per-resource cost allocations for a service or meter. ' +
        'These are local estimates, never official per-resource bills. unattributedCost ' +
        'retains charges that cannot be allocated. Resource totals cover the full window. ' +
        'daily covers the active cycle; ten-minute covers the latest 48 hours.',
      inputSchema: z.strictObject({ service, meter: meter.optional(), resolution, ...paging }),
      annotations,
    },
    ({ service, meter, resolution, offset, limit }) =>
      query(() => {
        const trend = resourceCostTrend(
          store,
          service,
          meter ?? null,
          resolution,
          collector.clock(),
        );
        if (!trend) return unavailable('Service or meter not found. Use list_billing_services.');
        const selected = page(trend.points, offset, limit);
        return result({
          ...trend,
          costBasis: 'estimated-resource-allocation',
          points: selected.rows,
          pagination: selected.pagination,
        });
      }),
  );

  server.registerTool(
    'get_daily_meter_trend',
    {
      description:
        "Read one UTC day's saved ten-minute usage intervals and cumulative daily estimated " +
        'cost for an exact service/meter. Both point arrays use the same pagination. ' +
        'Missing samples remain null; fixed subscription fees have no interval usage.',
      inputSchema: z.strictObject({ date, service, meter, ...paging }),
      annotations,
    },
    ({ date, service, meter, offset, limit }) =>
      query(() => {
        const trend = dailyMeterTrend(store, date, service, meter, collector.clock());
        if (!trend) return unavailable('Date, service or meter not found in the active cycle.');
        const selected = page(trend.usage.points, offset, limit);
        return result({
          ...trend,
          usage: { ...trend.usage, points: selected.rows },
          cost: { ...trend.cost, points: page(trend.cost.points, offset, limit).rows },
          pagination: selected.pagination,
        });
      }),
  );

  return server;
}
