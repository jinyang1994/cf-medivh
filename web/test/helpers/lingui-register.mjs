import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from '@babel/core';
import linguiMacro from '@lingui/babel-plugin-lingui-macro';

// Node's TypeScript support does not expand compile-time Lingui macros.
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (
      !url.startsWith('file:') ||
      (!url.includes('/src/') && !url.includes('/test/')) ||
      url.includes('/node_modules/')
    )
      return loaded;
    const source =
      typeof loaded.source === 'string'
        ? loaded.source
        : Buffer.from(loaded.source ?? '').toString();
    if (!/@lingui\/(core|react)\/macro/.test(source)) return loaded;
    const result = transformSync(source, {
      filename: fileURLToPath(url),
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ['typescript'] },
      plugins: [linguiMacro],
    });
    return { ...loaded, format: 'module', source: stripTypeScriptTypes(result.code) };
  },
});
