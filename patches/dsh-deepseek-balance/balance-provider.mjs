import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import { createBalanceReader } from './balance-api.js';

// rc.2 separates account and API-key routes. Only the API-key route owns this service.
export function registerBalanceProvider(ctx, provider, dependencies) {
  if (provider !== 'deepseek-official') return;
  let cached;
  const options = () => {
    const value = dependencies.options();
    if (cached === undefined || !deepEqualJson(cached, value)) cached = value;
    return cached;
  };
  ctx.on('loader/volatile-update', () => { cached = undefined; });
  const reader = createBalanceReader({ options, resolveApiKey: async connection => {
    const auth = await dependencies.resolveAuth(connection);
    const key = auth?.headers?.['x-api-key'];
    if (typeof key !== 'string' || key.length === 0) throw Error('API key unavailable');
    return key;
  } });
  ctx.provide('deepseekBalance', { read: () => reader.read() });
  ctx.effect(() => () => reader.dispose(), 'dshos-link-deepseek-balance');
}
