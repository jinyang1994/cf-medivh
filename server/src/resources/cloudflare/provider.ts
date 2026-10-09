import type {
  BillingCycle,
  CloudflareProvider,
  OfficialBill,
  UsageReport,
  UsageMeter,
} from '@/types';
import {
  analyticsQuery,
  datasets,
  quantitiesFromAnalytics,
  type AnalyticsData,
  type AnalyticsRow,
} from '@/resources/cloudflare/analytics';
import { meterDefinition, priceForServiceName } from '@/services/pricing';
import { PRICE_CATALOG_VERSION } from '@/constants/pricing';
import { marginalUsageCharge } from '@/services/calculation';
import { datesBetween, utcDate, utcDay, utcDayRange } from '@/utils/dates';
import groupBy from 'lodash/groupBy.js';
import sumBy from 'lodash/sumBy.js';
import uniq from 'lodash/uniq.js';

const API = 'https://api.cloudflare.com/client/v4';
interface Subscription {
  id: string;
  state: string;
  price: number;
  currency: string;
  current_period_start?: string;
  current_period_end?: string;
  rate_plan: { id: string; scope?: string };
}
interface BillingInfo {
  covered: boolean;
  subscriptions: {
    id: string;
    start_timestamp: string;
    billing_cycle_anchor_timestamp: string;
    end_timestamp?: string;
  }[];
}
export interface BillableRow {
  ServiceName: string;
  ServiceFamilyName: string;
  BillingPeriodStart: string;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  BillingCurrency: string;
  ConsumedQuantity: number;
  ContractedCost: number;
  SubscriptionId: string;
}
interface Envelope<T> {
  success?: boolean;
  result: T;
  errors?: { code?: number; message: string }[];
  result_info?: { total_pages?: number; next_page?: boolean };
}
export interface CloudflareConfig {
  accountId: string;
  token: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function cycleFromAnchor(
  anchor: string,
  started: string,
  now: Date,
): { start: string; end: string } {
  const original = utcDay(anchor);
  const began = utcDay(started);
  const current = utcDay(now);
  if (!original.isValid() || !began.isValid() || !current.isValid())
    throw new Error('Cloudflare 未提供有效的周期日期');
  const day = original.date();
  const originalMonth = original.startOf('month');
  const at = (offset: number) => {
    const month = originalMonth.add(offset, 'month');
    return month.date(Math.min(day, month.daysInMonth()));
  };
  let offset = (current.year() - original.year()) * 12 + current.month() - original.month();
  if (at(offset).isAfter(current)) offset--;
  const start = utcDate(at(offset).valueOf());
  const startedDate = utcDate(began.valueOf());
  return {
    start: startedDate > start ? startedDate : start,
    end: utcDate(at(offset + 1).valueOf()),
  };
}

interface NormalizedBillableRow {
  raw: BillableRow;
  key: string | null;
  cycleStart: string;
  date: string;
  end: number;
}

function normalizeBillableRows(rows: BillableRow[]): NormalizedBillableRow[] {
  return rows.map((row) => ({
    raw: row,
    key: priceForServiceName(row.ServiceName)?.key ?? null,
    cycleStart: utcDate(row.BillingPeriodStart),
    date: utcDate(row.ChargePeriodStart),
    end: utcDay(row.ChargePeriodEnd).valueOf(),
  }));
}

function officialFromRows(
  rows: NormalizedBillableRow[],
  cycle: BillingCycle,
  through: string,
): OfficialBill | null {
  const valid = rows.filter((row) => row.cycleStart === cycle.start);
  const boundary = utcDayRange(through).end;
  // Empty and lagging responses cannot substantiate a successful zero-dollar bill.
  if (!valid.some((row) => row.end >= boundary)) return null;
  const selected = valid.filter((row) => row.end <= boundary);
  let amount = cycle.baseFee ?? 0;
  const serviceCosts: Record<string, number> = { __base_fee: cycle.baseFee ?? 0 };
  for (const { raw: row, key } of selected) {
    if (row.BillingCurrency !== cycle.currency || !Number.isFinite(row.ContractedCost))
      throw new Error('Cloudflare 账单行金额或币种无效');
    amount += row.ContractedCost;
    if (key) serviceCosts[key] = (serviceCosts[key] ?? 0) + row.ContractedCost;
  }
  return {
    through,
    amount,
    currency: cycle.currency,
    serviceCosts,
    source: 'Cloudflare Billable Usage + Subscriptions',
    raw: { baseFee: cycle.baseFee ?? 0, records: selected.map((row) => row.raw) },
  };
}

/** Sum daily charges, never the running CumulatedContractedCost column. */
export function officialThrough(
  rows: BillableRow[],
  cycle: BillingCycle,
  through: string,
): OfficialBill | null {
  return officialFromRows(normalizeBillableRows(rows), cycle, through);
}

class Provider implements CloudflareProvider {
  private fetcher: typeof fetch;
  private now: () => Date;
  private paid: boolean | undefined;
  private officialCache = new Map<string, { at: number; rows: BillableRow[] }>();
  constructor(private config: CloudflareConfig) {
    if (!/^[a-f0-9]{32}$/.test(config.accountId) || !config.token)
      throw new Error('请配置 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN');
    this.fetcher = config.fetch ?? fetch;
    this.now = config.now ?? (() => new Date());
  }
  private async request<T>(path: string, body?: unknown): Promise<Envelope<T>> {
    const response = await this.fetcher(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cloudflare ${response.status} (${path.split('?')[0]})`);
    const result = (await response.json()) as Envelope<T>;
    if (result.success === false || result.errors?.length)
      throw new Error(
        `Cloudflare：${result.errors?.map((e) => e.message).join('；') ?? '请求失败'}`,
      );
    return result;
  }
  private account(path: string) {
    return `/accounts/${this.config.accountId}${path}`;
  }
  async getBillingCycle(now: Date): Promise<BillingCycle> {
    const [infoResponse, subscriptionsResponse] = await Promise.all([
      this.request<BillingInfo>(this.account('/billable-usage/info')),
      this.request<Subscription[]>(this.account('/subscriptions?per_page=50&page=1')),
    ]);
    const info = infoResponse.result;
    const subscriptions = subscriptionsResponse.result;
    for (let page = 2; page <= (subscriptionsResponse.result_info?.total_pages ?? 1); page++)
      subscriptions.push(
        ...(
          await this.request<Subscription[]>(
            this.account(`/subscriptions?per_page=50&page=${page}`),
          )
        ).result,
      );
    if (!info.covered || !info.subscriptions?.length)
      throw new Error('此账户尚未获得 Cloudflare Billable Usage API 覆盖');
    const active = info.subscriptions.filter(
      (s) => !s.end_timestamp || utcDay(s.end_timestamp).valueOf() > now.getTime(),
    );
    const periods = active.map((s) =>
      cycleFromAnchor(s.billing_cycle_anchor_timestamp, s.start_timestamp, now),
    );
    if (
      !periods.length ||
      periods.some((p) => p.start !== periods[0]!.start || p.end !== periods[0]!.end)
    )
      throw new Error('账户有不同账期的订阅，需要分别核算');
    const { start, end } = periods[0]!;
    const fees = subscriptions.filter(
      (s) =>
        s.price > 0 &&
        s.state === 'Paid' &&
        s.current_period_start &&
        utcDate(s.current_period_start) === start &&
        s.current_period_end &&
        utcDate(s.current_period_end) === end,
    );
    const currency = fees[0]?.currency ?? 'USD';
    if (fees.some((s) => s.currency !== currency)) throw new Error('账户有多币种订阅，无法合并');
    this.paid = subscriptions.some((s) => s.rate_plan.id === 'workers_paid');
    return {
      id: `${start}:${end}`,
      start,
      end,
      currency,
      baseFee: sumBy(fees, (subscription) => subscription.price),
      workersPaid: this.paid,
      source: 'Cloudflare Billable Usage Info / Subscriptions',
    };
  }
  private async billingRows(cycle: BillingCycle): Promise<BillableRow[]> {
    const cached = this.officialCache.get(cycle.id);
    if (cached && this.now().getTime() - cached.at < 590_000) return cached.rows;
    // Cloudflare requires this request range to include the billing anchor (end date).
    const response = await this.request<BillableRow[]>(
      this.account(`/billable-usage?from=${cycle.start}&to=${cycle.end}`),
    );
    if (!Array.isArray(response.result)) throw new Error('Cloudflare 账单响应格式无效');
    const rows = response.result;
    this.officialCache.set(cycle.id, { at: this.now().getTime(), rows });
    return rows;
  }
  async getOfficialBill(
    cycle: BillingCycle,
    through: string,
    localUsage?: UsageReport[],
  ): Promise<OfficialBill | null> {
    const rows = normalizeBillableRows(await this.billingRows(cycle));
    const bill = officialFromRows(rows, cycle, through);
    if (!bill) return null;
    const relevant = rows.filter((row) => row.cycleStart === cycle.start && row.date <= through);
    const dailyRows = new Set(
      relevant.map((row) => `${row.date}:${row.key ?? row.raw.ServiceName}`),
    );
    const coveredGroups = groupBy(
      relevant.filter((row) => row.key !== null),
      (row) => row.key!,
    );
    const totals = new Map<string, number>();
    const known = new Map((localUsage ?? []).map((r) => [r.date, r]));
    let completeHistory = true;
    for (const date of datesBetween(cycle.start, through)) {
      const report = known.get(date);
      if (!report?.complete) {
        completeHistory = false;
        continue;
      }
      for (const meter of report.meters) {
        const previous = totals.get(meter.key) ?? 0;
        const current = previous + meter.quantity;
        totals.set(meter.key, current);
        const delta = marginalUsageCharge(meter.pricing, meter.quantity, previous);
        // Billing products arrive independently. A positive expected daily charge without
        // its official product row is pending, even if another product has already arrived.
        if (delta > 0.000000001 && !dailyRows.has(`${date}:${meter.key}`)) return null;
      }
    }
    // Without complete analytics we cannot prove that a lagging metered product remained
    // inside its free allowance. Wait for backfill instead of finalizing an understated bill.
    if (!completeHistory) {
      const boundary = utcDayRange(through).end;
      if (Object.values(coveredGroups).some((group) => !group.some((row) => row.end >= boundary)))
        return null;
    }
    return bill;
  }
  private async analytics(dataset: string, date: string, end: string): Promise<AnalyticsRow[]> {
    const response = await this.fetcher(API + '/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: analyticsQuery(this.config.accountId, dataset, date, end) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${dataset} HTTP ${response.status}`);
    const json = (await response.json()) as {
      data?: { viewer?: { accounts?: AnalyticsData[] } };
      errors?: { message: string }[];
    };
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('；'));
    const rows = json.data?.viewer?.accounts?.[0]?.[dataset];
    if (!Array.isArray(rows)) throw new Error(`${dataset} 未返回用量`);
    if (rows.length >= 10000) throw new Error(`${dataset} 超出单次查询上限，需要缩小时间窗口`);
    return rows;
  }
  async getUsage(cycle: BillingCycle, date: string): Promise<UsageReport> {
    const paid = cycle.workersPaid ?? this.paid;
    if (paid === undefined)
      throw new Error('尚未确认 Workers 套餐，需成功获取订阅信息后才能估算用量费用');
    const observed = this.now();
    const { start, end: dayEnd } = utcDayRange(date);
    const until = Math.min(dayEnd, observed.getTime());
    if (start >= until) throw new Error('用量时间窗口无效');
    const end = utcDay(until).toISOString();
    const data: AnalyticsData = {};
    const failures: string[] = [];
    const names = Object.keys(datasets);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < names.length) {
          const name = names[cursor++]!;
          try {
            data[name] = await this.analytics(name, date, end);
          } catch (e) {
            failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }),
    );
    const { quantities, warnings } = quantitiesFromAnalytics(data, until);
    failures.push(...warnings);
    try {
      const response = await this.request<{
        run: { status: string };
        calculations: { calculation: string; aggregates: { value: number }[] }[];
      }>(this.account('/workers/observability/telemetry/query'), {
        queryId: 'medivh-billing-usage',
        timeframe: { from: start, to: until },
        view: 'calculations',
        dry: true,
        ignoreSeries: true,
        chartType: 'aggregate',
        parameters: { datasets: ['cloudflare-workers'], calculations: [{ operator: 'count' }] },
      });
      if (response.result.run.status !== 'COMPLETED') throw new Error('日志计数查询尚未完成');
      const aggregates = response.result.calculations.find(
        (c) => c.calculation === 'count',
      )?.aggregates;
      if (!aggregates) throw new Error('日志计数查询未返回汇总');
      quantities.worker_observability_events = sumBy(aggregates, (aggregate) => aggregate.value);
      if (until < utcDay(observed).subtract(7, 'day').valueOf())
        warnings.push(
          '启动前超过 7 天的 Workers Logs 已超出保留期；历史日志量不完整，日志费用仅从可用记录估算',
        );
    } catch (e) {
      failures.push(`Workers 日志：${e instanceof Error ? e.message : String(e)}`);
    }
    let knownRows: BillableRow[] = [];
    try {
      knownRows = await this.billingRows(cycle);
    } catch (e) {
      failures.push(`服务核对：${e instanceof Error ? e.message : String(e)}`);
    }
    const activeKeys = new Set<string>();
    for (const serviceName of uniq(knownRows.map((row) => row.ServiceName))) {
      const definition = priceForServiceName(serviceName, paid);
      if (!definition) failures.push(`尚未接入的计费服务：${serviceName}`);
      else activeKeys.add(definition.key);
    }
    const meters: UsageMeter[] = [];
    for (const [key, quantity] of Object.entries(quantities)) {
      if (
        quantity === 0 &&
        !activeKeys.has(key) &&
        ![
          'worker_standard_request',
          'worker_standard_cpu_ms',
          'worker_observability_events',
        ].includes(key)
      )
        continue;
      const definition = meterDefinition(key, paid);
      if (!definition) {
        if (quantity > 0) failures.push(`尚未接入单价：${key}`);
        continue;
      }
      meters.push({ ...definition, quantity });
    }
    for (const key of activeKeys)
      if (!(key in quantities)) failures.push(`未能取得活跃服务的用量：${key}`);
    return {
      date,
      observedAt: observed.toISOString(),
      meters,
      complete: failures.length === 0,
      warnings: uniq([...warnings, ...failures]),
      source: 'analytics',
      raw: {
        analytics: data,
        priceCatalogVersion: PRICE_CATALOG_VERSION,
        pricingSource: 'server/src/constants/pricing.ts',
      },
    };
  }
}

export function createCloudflareProvider(config: CloudflareConfig): CloudflareProvider {
  return new Provider(config);
}
