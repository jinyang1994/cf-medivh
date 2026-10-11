import type { ResourceCostTrend, ResourceUsageTrend } from '../types/billing';

export interface ResourceTrendSeries {
  key: string;
  toggleKey: string;
  name: string;
  resourceId?: string;
  total: number | null;
  kind: 'total' | 'resource' | 'unattributed' | 'official';
  colorIndex?: number;
}

function latestValue(values: (number | null)[]) {
  return values.findLast((value) => value != null && Number.isFinite(value)) ?? null;
}

export function resourceTrendSeries(data: ResourceUsageTrend | ResourceCostTrend) {
  const cost = 'currency' in data;
  const resources: ResourceTrendSeries[] = [...data.resources]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((resource, index) => ({
      key: `resource${index}`,
      toggleKey: JSON.stringify(['resource', resource.id]),
      name: resource.name,
      resourceId: resource.id,
      total: resource.total,
      kind: 'resource' as const,
      colorIndex: index,
    }))
    .sort((a, b) => b.total - a.total || a.resourceId.localeCompare(b.resourceId));
  const series: ResourceTrendSeries[] = [
    {
      key: 'total',
      toggleKey: JSON.stringify(['total']),
      name: '汇总',
      total: cost ? latestValue(data.points.map((point) => point.total)) : (data.total ?? null),
      kind: 'total',
    },
    ...resources,
  ];

  if (cost && data.points.some((point) => (point.unattributedCost ?? 0) > 0)) {
    series.push({
      key: 'unattributed',
      toggleKey: JSON.stringify(['unattributed']),
      name: '未归属费用',
      total: latestValue(data.points.map((point) => point.unattributedCost)),
      kind: 'unattributed',
    });
  }
  if (
    cost &&
    data.resolution === 'daily' &&
    data.points.some((point) => point.officialCost != null)
  ) {
    series.push({
      key: 'official',
      toggleKey: JSON.stringify(['official']),
      name: '官方汇总',
      total: latestValue(data.points.map((point) => point.officialCost)),
      kind: 'official',
    });
  }

  const points = data.points.map((point) => {
    const values: Record<string, number | null> = {};
    const resourceValues = 'costs' in point ? point.costs : point.quantities;
    for (const resource of resources) {
      const value = resourceValues[resource.resourceId!];
      values[resource.key] = value != null && Number.isFinite(value) ? value : null;
    }
    if ('costs' in point) {
      values.total = point.total;
      values.unattributed = point.unattributedCost;
      values.official = point.officialCost;
    } else {
      values.total = point.total ?? null;
    }
    return { timestamp: point.timestamp, time: Date.parse(point.timestamp), values };
  });

  return { series, points };
}
