export interface BillingCycle {
  /** Stable key, normally `${start}:${end}`. Boundaries are UTC dates; end is exclusive. */
  id: string;
  start: string;
  end: string;
  currency: string;
  /** Fixed recurring charges for this cycle, separate from usage overages. */
  baseFee?: number;
  /** Persist the Workers plan so same-cycle metadata fallback also preserves pricing allowances. */
  workersPaid?: boolean;
  source?: string;
}

export interface MeterPricing {
  currency: string;
  unitPrice: number;
  unitSize: number;
  includedQuantity: number;
  /** Allowances reset once per cycle unless explicitly daily. */
  allowancePeriod?: 'cycle' | 'day';
  /** Fixed subscription charge, charged once on the cycle's first day. */
  fixedFee?: number;
  rounding?: 'up';
  source?: string;
}

export interface UsageMeter {
  key: string;
  service: string;
  name: string;
  unit: string;
  /** Cumulative quantity within this UTC day, never the delta since the prior poll. */
  quantity: number;
  pricing: MeterPricing;
}

export interface UsageReport {
  date: string;
  observedAt: string;
  meters: UsageMeter[];
  /** False if any active service could not be measured or priced. */
  complete: boolean;
  warnings?: string[];
  source?: string;
  raw?: unknown;
}

export interface OfficialBill {
  through: string;
  amount: number;
  currency: string;
  source?: string;
  /** Cumulative official charges keyed by meter; __base_fee holds the subscription. */
  serviceCosts?: Record<string, number>;
  /** Keep the provider response that substantiates this successful official total. */
  raw?: unknown;
}

export interface CloudflareProvider {
  getBillingCycle(now: Date): Promise<BillingCycle>;
  /** Historical dates are requested for recovery/backfill and midnight finalization. */
  getUsage(cycle: BillingCycle, date: string): Promise<UsageReport>;
  /** null means not ready; failures and null are both retried on the next poll. */
  getOfficialBill(
    cycle: BillingCycle,
    through: string,
    localUsage?: UsageReport[],
  ): Promise<OfficialBill | null>;
}

export interface Reconciliation {
  date: string;
  officialTotal: number | null;
  localTotal: number | null;
  difference: number | null;
  localComplete: boolean;
  fetchedAt: string | null;
}

export interface ServiceSummary extends UsageMeter {
  quantity: number;
  todayQuantity: number;
  cost: number;
  todayCost: number;
  /** Yesterday's official charge plus today's locally calculated marginal charge. */
  currentCost?: number | null;
  officialCost?: number | null;
}

export interface BillingPoint {
  /** UTC ten-minute slot containing the actual realtime usage observation. */
  timestamp: string;
  observedAt: string | null;
  currentTotal: number | null;
  localTotal: number | null;
  officialHistorical: number | null;
  todayLocal: number | null;
  source?: 'collected' | 'reconstructed';
}

export interface BillingNotification {
  /** Optional for compatibility with previously queued successful collections. */
  kind?: 'billing';
  /** Stable identity of the successfully collected usage snapshot. */
  id: string;
  cycle: BillingCycle;
  point: BillingPoint;
  warnings: string[];
}

export interface CollectionFailureNotification {
  kind: 'collection_failure';
  id: string;
  attemptedAt: string;
  slot: string;
  cycle: BillingCycle | null;
  errors: string[];
  lastSuccessfulAt: string | null;
}

export type Notification = BillingNotification | CollectionFailureNotification;
export type NotificationSender = (notification: Notification) => Promise<void>;

export interface Dashboard {
  cycle: BillingCycle | null;
  asOf: string | null;
  today: string;
  currency: string;
  totals: {
    current: number | null;
    officialHistorical: number | null;
    officialThrough: string | null;
    todayLocal: number | null;
    localCumulative: number | null;
    difference: number | null;
    complete: boolean;
  };
  services: ServiceSummary[];
  history: Reconciliation[];
  timeline: BillingPoint[];
  collection: {
    running: boolean;
    lastAttempt: string | null;
    lastSuccess: string | null;
    nextRun: string | null;
    errors: string[];
    warnings: string[];
    missingUsageDates: string[];
    pendingOfficialDates: string[];
  };
}
