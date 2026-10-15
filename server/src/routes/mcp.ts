import { createHash, timingSafeEqual } from 'node:crypto';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { Middleware } from 'koa';
import type { McpConfig } from '@/config';
import { createBillingMcpServer } from '@/mcp/server';
import type { Store } from '@/repositories/billing-store';
import type { Collector } from '@/services/collector';
import { mcpTokenHash } from '@/services/mcp-settings';

const maxRequestBodySize = 64 * 1024;

export function mcpRoute(store: Store, collector: Collector, config?: McpConfig): Middleware {
  const allowedOrigins = new Set(config?.allowedOrigins);
  const modern = createMcpHandler(() => createBillingMcpServer(store, collector), {
    legacy: 'reject',
    responseMode: 'json',
    maxRequestBodySize,
    maxSubscriptions: 0,
  });
  const handler = toNodeHandler(
    {
      async fetch(request) {
        // The SDK's built-in legacy fallback always streams SSE. Use its official
        // legacy transport to preserve JSON responses for older MCP clients too.
        if (!(await isLegacyRequest(request, undefined, { maxRequestBodySize })))
          return modern.fetch(request);

        const server = createBillingMcpServer(store, collector);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
          maxRequestBodySize,
        });
        const abort = () => {
          void server.close().catch(() => {});
        };
        request.signal.addEventListener('abort', abort, { once: true });
        try {
          await server.connect(transport);
          return await transport.handleRequest(request);
        } finally {
          request.signal.removeEventListener('abort', abort);
          await server.close();
        }
      },
    },
    { maxRequestBodySize },
  );

  return async (ctx, next) => {
    if (ctx.path !== '/mcp' && !ctx.path.startsWith('/mcp/')) return next();
    ctx.set('Cache-Control', 'no-store');
    const expectedTokenHash = mcpTokenHash(store, config);
    if (!expectedTokenHash) {
      ctx.status = 404;
      ctx.body = { error: 'Not found' };
      return;
    }

    const authorization = ctx.get('Authorization');
    const token = /^Bearer ([\x21-\x7e]+)$/i.exec(authorization)?.[1];
    const authorizationCount = ctx.req.rawHeaders.filter(
      (header, index) => index % 2 === 0 && header.toLowerCase() === 'authorization',
    ).length;
    if (
      authorizationCount !== 1 ||
      !token ||
      !timingSafeEqual(createHash('sha256').update(token).digest(), expectedTokenHash)
    ) {
      ctx.status = 401;
      ctx.set('WWW-Authenticate', 'Bearer realm="cf-medivh-mcp"');
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const origin = ctx.req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden origin' };
      return;
    }
    if (ctx.path !== '/mcp') {
      ctx.status = 404;
      ctx.body = { error: 'Not found' };
      return;
    }
    if (ctx.method !== 'POST') {
      ctx.status = 405;
      ctx.set('Allow', 'POST');
      ctx.body = {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
        id: null,
      };
      return;
    }

    ctx.respond = false;
    try {
      await handler(ctx.req, ctx.res);
    } catch {
      if (ctx.res.headersSent) ctx.res.destroy();
      else {
        ctx.respond = true;
        ctx.status = 500;
        ctx.body = {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        };
      }
    }
  };
}
