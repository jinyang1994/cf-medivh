import { formatter } from '@lingui/format-po';
import { defineConfig } from '@lingui/cli';

export default defineConfig({
  locales: ['zh-CN', 'en'],
  sourceLocale: 'zh-CN',
  catalogs: [{ path: '<rootDir>/src/locales/{locale}/messages', include: ['<rootDir>/src'] }],
  format: formatter({ lineNumbers: false }),
});
