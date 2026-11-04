/**
 * Decimal money parsing for CRMEB outapi.
 *
 * CRMEB stores money as MySQL `decimal(12,2)` and PDO returns it as a **string
 * in yuan**. `Number(price) * 100` / `parseFloat` are forbidden here: they can
 * lose a cent for values such as "0.29" and silently accept malformed input.
 * This parser works on the decimal digits only and returns `null` for anything
 * that is not a non-negative amount with at most two decimal places.
 */
export function parseDecimalYuanToCents(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null
    const cents = value * 100
    const rounded = Math.round(cents)
    // Numbers are only tolerated because the upstream field type is not
    // guaranteed in every deployment; reject anything that is not exactly
    // representable to a cent.
    return Math.abs(cents - rounded) < 1e-6 ? rounded : null
  }

  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const [wholePart, fractionPart = ''] = trimmed.split('.')
  const whole = Number(wholePart)
  if (!Number.isSafeInteger(whole)) return null
  const fraction = Number(fractionPart.padEnd(2, '0'))
  const cents = whole * 100 + fraction
  return Number.isSafeInteger(cents) ? cents : null
}
