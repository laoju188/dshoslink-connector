import { z } from 'zod/mini';
const result = z.strictObject({ phase: z.string(), currentVersion: z.string(), targetVersion: z.string(), reason: z.string(), canRecover: z.boolean() });
export const descriptors = ['snapshot', 'start', 'recover'].map(method => ({
  id: `@dshos-link/connector-updater#dshosUpgrade/${method}`, service: 'dshosUpgrade', namespace: 'dshosUpgrade', method,
  invocation: { kind: 'direct' }, parameters: [], result: { mode: 'strict', typeSymbol: `@dshos-link/connector-updater#dshosUpgrade/${method}:result`, schema: result, create: () => result },
}));
export const TYPERT_REMOTE = { package: '@dshos-link/connector-updater', descriptors };
export const TYPERT = { package: '@dshos-link/connector-updater', face: 'host', schemas: [], invocations: descriptors, model: { services: [], events: [], objects: [] } };
export default TYPERT;
