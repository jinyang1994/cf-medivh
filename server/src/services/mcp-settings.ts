import { createHash, randomBytes } from 'node:crypto';
import type { McpConfig } from '@/config';
import type { Store } from '@/repositories/billing-store';
import { maskSecret } from '@/services/secret-preview';

const key = 'runtimeMcpSettings';

interface StoredMcpSettings {
  tokenHash: string | null;
  maskedToken: string;
  updatedAt: string | null;
}

function currentSettings(store: Store, config?: McpConfig): StoredMcpSettings {
  const saved = store.get(key);
  if (saved !== null) {
    let value: unknown;
    try {
      value = JSON.parse(saved);
    } catch {
      throw new Error('Invalid stored MCP settings');
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('tokenHash' in value) ||
      (value.tokenHash !== null &&
        (typeof value.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.tokenHash))) ||
      !('maskedToken' in value) ||
      typeof value.maskedToken !== 'string' ||
      !('updatedAt' in value) ||
      (value.updatedAt !== null && typeof value.updatedAt !== 'string')
    )
      throw new Error('Invalid stored MCP settings');
    return value as StoredMcpSettings;
  }
  const token = config?.token;
  return {
    tokenHash: token ? createHash('sha256').update(token).digest('hex') : null,
    maskedToken: maskSecret(token ?? ''),
    updatedAt: null,
  };
}

export function mcpSettings(store: Store, config?: McpConfig) {
  const settings = currentSettings(store, config);
  return {
    enabled: settings.tokenHash !== null,
    maskedToken: settings.tokenHash ? settings.maskedToken : '',
    updatedAt: settings.updatedAt,
    endpoint: '/mcp' as const,
  };
}

export function mcpTokenHash(store: Store, config?: McpConfig): Buffer | null {
  const hash = currentSettings(store, config).tokenHash;
  return hash === null ? null : Buffer.from(hash, 'hex');
}

export function generateMcpToken() {
  // Drafts are deliberately not persisted. The active credential only changes
  // when the dashboard saves all settings in one transaction.
  return { token: randomBytes(32).toString('hex') };
}

export function prepareMcpSettings(input: unknown): StoredMcpSettings | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('action' in input))
    throw new Error('invalid_mcp');
  if (input.action === 'rotate') {
    if (
      Object.keys(input).length !== 2 ||
      !('token' in input) ||
      typeof input.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.token)
    )
      throw new Error('invalid_mcp');
    return {
      tokenHash: createHash('sha256').update(input.token).digest('hex'),
      maskedToken: maskSecret(input.token),
      updatedAt: new Date().toISOString(),
    };
  }
  if (input.action !== 'revoke' || Object.keys(input).length !== 1) throw new Error('invalid_mcp');
  // Persist a disabled override so an environment token cannot return on restart.
  const settings: StoredMcpSettings = {
    tokenHash: null,
    maskedToken: '',
    updatedAt: new Date().toISOString(),
  };
  return settings;
}

export function savePreparedMcpSettings(store: Store, settings: StoredMcpSettings | undefined) {
  if (settings !== undefined) store.set(key, JSON.stringify(settings));
}
