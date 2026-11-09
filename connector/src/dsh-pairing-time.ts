// A fresh first-party HTTPS Date is an upper bound after allowing its one-second
// precision and the bounded request duration. Never change the OS clock or extend
// a proof beyond its signed expiry. Large clock errors require user correction.
export function pairingClockOffset(date: string | null, age: string | null, started: number, ended: number): number {
  const stamp = date === null ? NaN : Date.parse(date)
  if (!Number.isSafeInteger(started) || !Number.isSafeInteger(ended) || ended < started || ended - started >= 5000
    || !Number.isSafeInteger(stamp) || stamp < 0 || new Date(stamp).toUTCString() !== date
    || age !== null && age !== '0') throw Error('enrollment_service_time')
  const offset = stamp + 1000 + ended - started - ended
  if (Math.abs(offset) > 120000) throw Error('enrollment_clock_settings')
  return offset
}
