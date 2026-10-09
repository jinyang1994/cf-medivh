import type { Middleware } from 'koa';

export const errorHandler: Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: '服务暂时不可用' };
    ctx.app.emit('error', error, ctx);
  }
};
