import type { Context } from '@deepseek-ai/cordis'
import { registerPairingLifecycle } from './pairing-windows-registration.js'
import { CONNECTOR_METADATA } from './connector-metadata.js'
import { assertDesktopDependencyRecovery, prepareDesktopPairingEnvironment, readRuntimeDshKind } from './runtime-version.js'
import { registerConnectorUpdate } from './connector-update.js'

export {
  CONNECTOR_METADATA,
  CONNECTOR_VERSION,
  SUPPORTED_DSH_COMMIT,
  SUPPORTED_DSH_VERSION,
  SUPPORTED_DSH_VERSIONS,
} from './connector-metadata.js'

/** Cordis diagnostic label for the plugin. */
export const name = CONNECTOR_METADATA.name

/** Load the production Pairing V1 connector runtime. */
export async function apply(ctx: Context): Promise<void> {
  // The current connector is Desktop-only. Loading it in Web never starts pairing,
  // discovery or relay services. Historical Web state is left untouched.
  if (readRuntimeDshKind() !== 'desktop') return
  assertDesktopDependencyRecovery(ctx.baseUrl)
  const updates = registerConnectorUpdate(ctx)
  await registerPairingLifecycle(ctx, await prepareDesktopPairingEnvironment(process.env), { updateDiagnostic: () => updates.diagnostic() })
}
