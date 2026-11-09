import type { StartupDiagnostic, StartupReason } from './startup-diagnostic.js'
// Safe local cause only. Never include paths, protected bytes or child stderr.
export type PairingStartupFailure = 'SECURE_STORAGE_TIMEOUT' | 'SECURE_STORAGE' | 'IDENTITY' | 'STORAGE' | 'REGISTRATION'
export class PairingStartupError extends Error {
  constructor(readonly stage: PairingStartupFailure, message = 'Windows pairing runtime unavailable',
    readonly startup?: StartupDiagnostic, readonly startupReason?: StartupReason) {
    super(message)
    this.name = 'PairingStartupError'
  }
}
