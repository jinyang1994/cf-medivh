import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceTotals } from '../src/utils/service-totals.ts';
import type { ServiceSummary } from '../src/types/billing.ts';

const meter = (
  service: string,
  cost: number,
  currentCost: number | null | undefined,
  todayCost = 0,
): ServiceSummary => ({
  key: `${service}-${cost}`,
  service,
  name: 'Usage',
  unit: 'requests',
  quantity: 0,
  todayQuantity: 0,
  cost,
  currentCost,
  todayCost,
  pricing: { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 0 },
});

test('official service charges remain separate from the local estimate', () => {
  const [workers] = serviceTotals([meter('Workers', 2, 3, 0.25), meter('Workers', 5, 6, 0.5)]);
  assert.equal(workers.cost, 7);
  assert.equal(workers.currentCost, 9);
  assert.equal(workers.todayCost, 0.75);
});

test('missing official details retain and sort by existing cycle estimates', () => {
  const groups = serviceTotals([
    meter('Workers', 0, null),
    meter('Containers', 0.6, undefined, 0.00288),
    meter('Containers', 0.15, null),
    meter('订阅', 5, null),
  ]);
  assert.deepEqual(
    groups.map(({ service, currentCost, cost }) => [service, currentCost ?? cost]),
    [
      ['订阅', 5],
      ['Containers', 0.75],
      ['Workers', 0],
    ],
  );
  assert.equal(
    groups.every((row) => row.currentCost === null),
    true,
  );
  assert.equal(groups[1].todayCost, 0.00288);
});

test('a service with partial official details falls back to its entire local estimate', () => {
  const [workers] = serviceTotals([meter('Workers', 2, 3), meter('Workers', 5, null)]);
  assert.equal(workers.currentCost, null);
  assert.equal(workers.currentCost ?? workers.cost, 7);
});

test('an official zero is available and takes precedence over a positive estimate', () => {
  const groups = serviceTotals([meter('Workers', 10, 0), meter('Containers', 1, null)]);
  assert.deepEqual(
    groups.map(({ service, currentCost, cost }) => [service, currentCost ?? cost]),
    [
      ['Containers', 1],
      ['Workers', 0],
    ],
  );
});
