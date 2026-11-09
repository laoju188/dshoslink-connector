import type { Context } from '@deepseek-ai/cordis'
import { supportsInAppUpgrade } from './connector-upgrade-policy.js'

export class UpgradePreflightError extends Error {
  constructor(readonly code: string) { super(code) }
}

/** Shared by the first bootstrap and the independent installer before each update. */
export async function assertUpgradePreflight(ctx: Pick<Context, 'get'>, hostVersion: string, recovery = false): Promise<string> {
  if (!supportsInAppUpgrade(hostVersion) || !ctx.get('hmr')) throw new UpgradePreflightError('host-not-supported')
  const manager = ctx.get('pluginManager') as unknown as Record<string, unknown> | undefined
  if (!manager || ['listBundles', 'listPlugins', 'installBundle', 'removeBundle'].some(name => typeof manager[name] !== 'function')) {
    throw new UpgradePreflightError('host-api-unavailable')
  }
  type Job = { status: string }
  type Agent = Job & { id: string; inbox?: { nextTurn?: unknown[]; nextStep?: unknown[] } }
  const agents = ctx.get('agents') as { list(): Agent[] | Promise<Agent[]> } | undefined
  const jobs = ctx.get('jobs') as { list(agentId?: string): Job[] | Promise<Job[]> } | undefined
  if (!agents || !jobs || typeof agents.list !== 'function' || typeof jobs.list !== 'function') throw new UpgradePreflightError('activity-unavailable')
  const active = (job: Job) => job.status === 'running' || job.status === 'stopping'
  if ((await jobs.list()).some(active)) throw new UpgradePreflightError('tasks-running')
  for (const agent of await agents.list()) {
    if (active(agent) || agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length
      || (await jobs.list(agent.id)).some(active)) throw new UpgradePreflightError('tasks-running')
  }
  const pairing = ctx.get('dshosCloudPairing') as { canUpgrade?(): boolean } | undefined
  if (!recovery && pairing?.canUpgrade?.() !== true) throw new UpgradePreflightError('pairing-busy')
  return hostVersion
}
