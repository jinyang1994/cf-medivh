import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  cycleContains,
  datesBetween,
  nextSlot,
  slotKey,
  utcDate,
  utcDay,
  utcDayRange,
  utcDayStart,
  validDate,
} from '@/utils/dates';

test('UTC calendar helpers preserve timestamp offsets and do not use the host calendar day', () => {
  const instant = '2026-10-08T00:30:15.125+08:00';
  assert.equal(utcDay(instant).isUTC(), true);
  assert.equal(utcDay(instant).toISOString(), '2026-10-07T16:30:15.125Z');
  assert.equal(utcDate(instant), '2026-10-07');
  assert.equal(utcDate(new Date(instant)), '2026-10-07');
  assert.equal(utcDate(Date.parse(instant)), '2026-10-07');
  assert.equal(utcDayStart(instant), Date.parse('2026-10-07T00:00:00Z'));
  assert.deepEqual(utcDayRange(instant), {
    start: Date.parse('2026-10-07T00:00:00Z'),
    end: Date.parse('2026-10-08T00:00:00Z'),
  });
});

test('a UTC day range ends at the next midnight, including month-end and daylight-saving dates', () => {
  assert.deepEqual(utcDayRange('2024-02-29'), {
    start: Date.parse('2024-02-29T00:00:00Z'),
    end: Date.parse('2024-03-01T00:00:00Z'),
  });
  const range = utcDayRange('2026-03-08T01:30:00-08:00');
  assert.equal(range.start, Date.parse('2026-03-08T00:00:00Z'));
  assert.equal(range.end, Date.parse('2026-03-09T00:00:00Z'));
});

test('strict date validation rejects normalization, invalid leap days, and extra timestamp text', () => {
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2026-10-08'), true);
  for (const input of [
    '2026-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-00-01',
    '2026-1-03',
    '2026-10-08T00:00:00Z',
    '',
    'invalid',
  ])
    assert.equal(validDate(input), false, input);
  assert.equal(utcDay('2026-02-30').isValid(), false);
  assert.throws(() => utcDayRange('2026-02-30'), RangeError);
  assert.throws(() => utcDate(new Date(NaN)), RangeError);
});

test('daily iteration includes both endpoints and handles leap days, year rollover, and invalid ranges', () => {
  assert.deepEqual(datesBetween('2024-02-28', '2024-03-01'), [
    '2024-02-28',
    '2024-02-29',
    '2024-03-01',
  ]);
  assert.deepEqual(datesBetween('2026-12-31', '2027-01-01'), ['2026-12-31', '2027-01-01']);
  assert.deepEqual(datesBetween('2026-10-08', '2026-10-08'), ['2026-10-08']);
  assert.deepEqual(datesBetween('2026-10-09', '2026-10-08'), []);
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.throws(() => datesBetween('invalid', '2026-10-08'), RangeError);
  assert.throws(() => datesBetween('2026-10-08', '2026-02-30'), RangeError);
  assert.throws(() => addDays('2026-02-30', 1), RangeError);
  assert.throws(() => addDays('2026-10-08', NaN), RangeError);
});

test('billing cycle inclusion is start-inclusive and end-exclusive and rejects malformed cycles', () => {
  const cycle = { start: '2026-09-16', end: '2026-10-16' };
  assert.equal(cycleContains(cycle, '2026-09-15'), false);
  assert.equal(cycleContains(cycle, '2026-09-16'), true);
  assert.equal(cycleContains(cycle, '2026-10-15'), true);
  assert.equal(cycleContains(cycle, '2026-10-16'), false);
  assert.equal(cycleContains(cycle, 'invalid'), false);
  assert.equal(cycleContains({ start: '2026-02-30', end: '2026-03-20' }, '2026-03-01'), false);
  assert.equal(cycleContains({ start: cycle.end, end: cycle.start }, '2026-10-08'), false);
});

test('ten-minute slots remain aligned at exact boundaries and across UTC midnight', () => {
  assert.equal(slotKey(new Date('2026-10-08T23:59:59.999Z')), '2026-10-08T23:50:00.000Z');
  assert.equal(
    nextSlot(new Date('2026-10-08T23:59:59.999Z')).toISOString(),
    '2026-10-09T00:00:00.000Z',
  );
  assert.equal(slotKey(new Date('2026-10-09T00:10:00.000Z')), '2026-10-09T00:10:00.000Z');
  assert.equal(
    nextSlot(new Date('2026-10-09T00:10:00.000Z')).toISOString(),
    '2026-10-09T00:20:00.000Z',
  );
});
