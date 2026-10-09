import { PRICE_CATALOGUE, type CatalogueEntry } from '@/constants/pricing';
import type { UsageMeter } from '@/types';

export type MeterDefinition = Omit<UsageMeter, 'quantity'>;

function definition(item: CatalogueEntry, paid: boolean): MeterDefinition {
  return {
    key: item.key,
    service: item.service,
    name: item.name,
    unit: item.unit,
    pricing: { ...item.pricing, ...(!paid ? item.free : {}) },
  };
}

export function meterDefinition(key: string, paid = true): MeterDefinition | null {
  const item = PRICE_CATALOGUE.find((item) => item.key === key);
  return item ? definition(item, paid) : null;
}

export function priceForServiceName(name: string, paid = true): MeterDefinition | null {
  const item = PRICE_CATALOGUE.find((item) => item.key === name || item.match.test(name));
  return item ? definition(item, paid) : null;
}

export function meterDefinitions(paid = true): MeterDefinition[] {
  return PRICE_CATALOGUE.map((item) => definition(item, paid));
}
