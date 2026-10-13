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
  /** How the persisted daily quantity was obtained; absent on legacy records. */
  quantitySource?: 'official-aggregate' | 'resource-sum';
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
  /** Resource analytics are independent of billing collection and never send notifications. */
  getResourceTrend?(
    cycle: BillingCycle,
    service: string,
    meterKey: string,
    resolution: 'ten-minute' | 'daily',
    window?: { start: string; end: string },
  ): Promise<ResourceUsageTrend>;
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
  /** Change in cumulative difference from the immediately preceding UTC day. */
  dailyDifference?: number | null;
  dailyCost?: number | null;
  dailyCostSource?: 'official' | 'estimate' | null;
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

export interface ServiceTrendPoint {
  timestamp: string;
  observedAt: string | null;
  localCost: number | null;
  officialCost: number | null;
  /** Cumulative cycle usage; only available when a single meter is selected. */
  quantity: number | null;
}

export interface ServiceTrend {
  cycle: BillingCycle;
  service: string;
  meterKey: string | null;
  name: string;
  unit: string | null;
  currency: string;
  history: ServiceTrendPoint[];
  timeline: ServiceTrendPoint[];
}

export interface ResourceUsageTrend {
  service: string;
  meterKey: string;
  unit: string;
  /** Cloudflare storage datasets may only expose hourly samples. */
  resolution: 'ten-minute' | 'hourly' | 'daily';
  start: string;
  end: string;
  fetchedAt: string;
  resources: { id: string; name: string; total: number }[];
  /** Quantities within each interval, never cumulative charges or allocated account fees. */
  points: { timestamp: string; quantities: Record<string, number | null>; total?: number | null }[];
  /** Service meter total for the selected interval; populated by the read API. */
  total?: number | null;
  totalComplete?: boolean;
  /** Independently completed API windows, persisted for incremental recovery. */
  coverage?: { start: string; end: string; complete: boolean }[];
  warnings: string[];
  unavailableReason: string | null;
}

/** Estimated allocation of stored local cumulative charges, never official per-resource bills. */
export interface ResourceCostTrend {
  service: string;
  meterKey: string | null;
  currency: string;
  resolution: 'ten-minute' | 'daily';
  start: string;
  end: string;
  fetchedAt: string;
  resources: { id: string; name: string; total: number }[];
  points: {
    timestamp: string;
    total: number | null;
    officialCost: number | null;
    costs: Record<string, number | null>;
    unattributedCost: number | null;
  }[];
  warnings: string[];
  unavailableReason: string | null;
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
export type NotificationSender = (
  notification: Notification,
  previousBilling?: BillingNotification | null,
) => Promise<void>;

export interface BudgetAlertNotification {
  kind: 'budget_exceeded';
  /** Stable per billing cycle, including across delivery retries and restarts. */
  id: string;
  cycle: BillingCycle;
  observedAt: string;
  metric: 'currentTotal';
  /** Integer US cents; 30000 means USD 300. */
  thresholdCents: number;
  /** Preserve the observed dollar amount, including fractions of a cent. */
  amountUsd: number;
}

export type DeliveryNotification = Notification | BudgetAlertNotification;

export interface NotificationExtension {
  id: string;
  label: string;
  retry?: 'until_success';
  prepare(notification: Notification): DeliveryNotification | null;
  /** Last successfully delivered billing summary for this target, excluding failure alerts. */
  send(
    notification: DeliveryNotification,
    previousBilling?: BillingNotification | null,
  ): Promise<void>;
}

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

export interface DailyServices {
  date: string;
  cycle: BillingCycle;
  currency: string;
  complete: boolean;
  services: {
    key: string;
    service: string;
    name: string;
    unit: string;
    pricing: MeterPricing;
    quantity: number | null;
    cost: number | null;
    officialQuantity: number | null;
    officialCost: number | null;
    quantityDifference: number | null;
    costDifference: number | null;
    /** Selected day usage above the remaining allowance, before billing-unit rounding. */
    overageQuantity: number | null;
    /** Actual usage in the allowance window, including usage above the free limit. */
    allowanceUsed: number | null;
    allowanceRatio: number | null;
  }[];
}
