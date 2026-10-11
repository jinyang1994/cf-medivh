import { t } from '@lingui/core/macro';
import test from 'node:test';
import assert from 'node:assert/strict';
import { i18n } from '@lingui/core';
import { messages as english } from '../src/locales/en/messages.ts';
import { messages as chinese } from '../src/locales/zh-CN/messages.ts';
import { resolveLocale } from '../src/utils/locale.ts';
import { displayText } from '../src/utils/display-text.ts';
import { serviceTrendPath } from '../src/constants/billing-navigation.ts';
import { money } from '../src/utils/format.ts';

i18n.load({ en: english, 'zh-CN': chinese });

test('saved language overrides the browser and unsupported languages fall back to English', () => {
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLocale(null, 'zh-TW'), 'zh-CN');
  assert.equal(resolveLocale(null, 'en-US'), 'en');
  assert.equal(resolveLocale('invalid', 'fr-FR'), 'en');
});

test('both catalogs cover the same messages, including English plurals and interpolations', () => {
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
  i18n.activate('en');
  assert.equal(t`${{ count: 1 }} 天待同步`, '1 day pending sync');
  assert.equal(t`${{ count: 3 }} 天待同步`, '3 days pending sync');
  assert.equal(
    t`当前账期第 ${{ value0: 18 }} 天，共 ${{ value1: 30 }} 天`,
    'Day 18 of 30 in this billing cycle',
  );
  i18n.activate('zh-CN');
  assert.equal(t`${{ count: 3 }} 天待同步`, '3 天待同步');
});

test('language changes update labels, errors and money without changing canonical routes or unknown resource names', () => {
  const route = serviceTrendPath('订阅', '__base_fee');
  i18n.activate('en');
  assert.equal(displayText('订阅'), 'Subscription');
  assert.equal(displayText('内存'), 'Memory');
  assert.equal(displayText('账单加载失败（503）'), 'Failed to load billing data (503)');
  assert.equal(
    displayText('内存尚无资源用量记录，相应费用保留为未归属。'),
    'No resource usage is recorded for Memory; its costs remain unattributed.',
  );
  assert.equal(displayText('my-worker'), 'my-worker');
  assert.equal(money(1), '$1.00');
  i18n.activate('zh-CN');
  assert.equal(displayText('订阅'), '订阅');
  assert.equal(displayText('内存'), '内存');
  assert.equal(serviceTrendPath('订阅', '__base_fee'), route);
  assert.equal(money(1), 'US$1.00');
});

test('nested translation macros preserve interpolated text in both languages', () => {
  const through = '2026/10/11';
  i18n.activate('en');
  assert.equal(
    t`截至 ${{ value0: through }} · ${{ value1: t`本地估算` }}`,
    'As of 2026/10/11 · Local estimate',
  );
  i18n.activate('zh-CN');
  assert.equal(
    t`截至 ${{ value0: through }} · ${{ value1: t`本地估算` }}`,
    '截至 2026/10/11 · 本地估算',
  );
});
