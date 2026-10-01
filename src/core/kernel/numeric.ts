/** Kernel v1 uses safe integer ticks, resource units and work units. Fractions floor. */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function assertNonNegativeInteger(value: number, label: string): void {
  if (!isNonNegativeInteger(value)) throw new RangeError(`${label} must be a non-negative safe integer`);
}

export function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError('Safe integer overflow');
  return result;
}

/** Multiplication is deliberately checked before integer division. */
export function multiplyDivideFloor(value: number, numerator: number, denominator: number): number {
  assertNonNegativeInteger(value, 'value');
  assertNonNegativeInteger(numerator, 'numerator');
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new RangeError('Invalid denominator');
  const product = value * numerator;
  if (!Number.isSafeInteger(product)) throw new RangeError('Safe integer overflow');
  return Math.floor(product / denominator);
}
