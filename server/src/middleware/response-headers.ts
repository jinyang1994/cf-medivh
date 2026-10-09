import type { Middleware } from 'koa';

export const responseHeaders: Middleware = async (ctx, next) => {
  ctx.set('X-Content-Type-Options', 'nosniff');
  if (ctx.path.startsWith('/api/')) ctx.set('Cache-Control', 'no-store');
  await next();
};
