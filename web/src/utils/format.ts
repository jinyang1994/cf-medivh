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
  return value?.slice(0, 10) ?? '—';
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
  return new Date(new Date(exclusiveEnd).getTime() - 86_400_000).toISOString().slice(0, 10);
}
