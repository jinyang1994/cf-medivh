import type { Middleware } from 'koa';
import type { McpConfig } from '@/config';
import type { Store } from '@/repositories/billing-store';
import { generateMcpToken, mcpSettings } from '@/services/mcp-settings';

const maxRequestBodySize = 1024;

export function mcpSettingsRoute(store: Store, config?: McpConfig): Middleware {
  return async (ctx, next) => {
    const settingsPath = ctx.path === '/api/settings/mcp';
    if (!settingsPath && ctx.path !== '/api/settings/mcp/token') return next();
    ctx.set('Cache-Control', 'no-store');

    // Like the other settings routes, administration uses the dashboard's access
    // boundary. Browser requests must originate from that dashboard, including
    // its development proxy, which preserves the original Host header.
    const origin = ctx.req.headers.origin;
    let foreignOrigin = false;
    if (origin !== undefined) {
      try {
        const url = new URL(origin);
        foreignOrigin =
          !['http:', 'https:'].includes(url.protocol) ||
          url.origin !== origin ||
          url.host !== ctx.host;
      } catch {
        foreignOrigin = true;
      }
    }
    const site = ctx.get('Sec-Fetch-Site');
    if (foreignOrigin || (site && site !== 'same-origin' && site !== 'none')) {
      ctx.status = 403;
      ctx.body = { error: 'Cross-origin request rejected' };
      return;
    }

    if (settingsPath && ctx.method === 'GET') {
      ctx.body = mcpSettings(store, config);
      return;
    }
    if (settingsPath || ctx.method !== 'POST') {
      ctx.status = 405;
      ctx.set('Allow', settingsPath ? 'GET' : 'POST');
      ctx.body = { error: 'Method not allowed' };
      return;
    }
    if (ctx.request.type !== 'application/json') {
      ctx.status = 415;
      ctx.body = { error: 'Expected application/json' };
      return;
    }
    if (Number(ctx.get('Content-Length')) > maxRequestBodySize) {
      ctx.status = 413;
      ctx.body = { error: 'Request body too large' };
      return;
    }
    let body = '';
    let bytes = 0;
    for await (const chunk of ctx.req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxRequestBodySize) {
        ctx.status = 413;
        ctx.body = { error: 'Request body too large' };
        return;
      }
      body += chunk.toString();
    }
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      input = null;
    }
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 0
    ) {
      ctx.status = 400;
      ctx.body = { error: 'Expected an empty JSON object' };
      return;
    }
    ctx.body = generateMcpToken();
  };
}
