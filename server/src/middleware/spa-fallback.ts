import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Middleware } from 'koa';

export function spaFallback(webRoot: string): Middleware {
  return async (ctx) => {
    if (ctx.method !== 'GET' || !ctx.accepts('html')) return;
    try {
      ctx.type = 'html';
      ctx.body = await readFile(join(webRoot, 'index.html'), 'utf8');
    } catch {
      ctx.status = 404;
    }
  };
}
