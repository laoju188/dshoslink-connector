// A disposed runtime can still be releasing its asynchronous Windows lease.
// Wait briefly for the existing owner; never remove or bypass a live lock.
export async function resumeDshRetirement(initialize: () => Promise<void>,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<void> {
  const delays = [50, 100, 200, 400, 800]
  for (let attempt = 0; ; attempt++) {
    try { await initialize(); return }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'registration_busy' || attempt === delays.length) throw error
      await pause(delays[attempt]!)
    }
  }
}
