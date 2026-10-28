/** Decimal precision shared by source decoding and editable business data. @author hanzhichao7 */

/**
 * Check the decimal representation sent to the enterprise service without multiplying floating-point values.
 * @param value - Finite decimal value; exponential notation is interpreted with its actual decimal scale.
 * @returns Whether the number has at most four decimal places.
 */
export function hasBusinessPrecision(value: number): boolean {
  const [mantissa = '', exponent = '0'] = String(value).toLowerCase().split('e')
  return Number.isFinite(value) && (mantissa.split('.')[1]?.length ?? 0) - Number(exponent) <= 4
}
