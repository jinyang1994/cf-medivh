export function money(
  value: number | null | undefined,
  currency = 'USD',
  precise: boolean | 'rate' = false,
) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value !== 0 && Math.abs(value) < 1e-12) return `${currency} ${value.toExponential()}`;
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits:
      precise === 'rate'
        ? 12
        : Math.min(
            12,
            Math.max(
              precise ? 4 : 2,
              value !== 0 && Math.abs(value) < 0.01
                ? Math.ceil(-Math.log10(Math.abs(value))) + 2
                : 0,
            ),
          ),
  }).format(value);
}

export function quantity(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.0001 ? 12 : 4,
  }).format(value);
}

export function date(value: string | null | undefined) {
  return value?.slice(0, 10).replaceAll('-', '/') ?? '—';
}

export function shortDate(value: string) {
  return value.slice(5, 10).replace('-', '/');
}

export function timestamp(value: string | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

export function inclusiveEnd(exclusiveEnd: string) {
  return date(new Date(new Date(exclusiveEnd).getTime() - 86_400_000).toISOString());
}

export function cycleProgress(cycle: { start: string; end: string } | null, today: string) {
  if (!cycle) return null;
  const start = Date.parse(cycle.start);
  const total = Math.round((Date.parse(cycle.end) - start) / 86_400_000);
  const current = Math.floor((Date.parse(today) - start) / 86_400_000) + 1;
  if (!Number.isFinite(total) || !Number.isFinite(current) || total <= 0) return null;
  return { current: Math.max(0, Math.min(current, total)), total };
}
