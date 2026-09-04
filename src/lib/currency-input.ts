export type DollarAmountValidationCode =
  | 'INVALID'
  | 'PRECISION'
  | 'TOO_LARGE'
  | 'BELOW_MINIMUM'
  | 'ABOVE_MAXIMUM';

export type DollarAmountValidationResult =
  | { valid: true; amountCents: number }
  | { valid: false; code: DollarAmountValidationCode; message: string };

export interface DollarAmountValidationOptions {
  minimumCents?: number;
  maximumCents?: number;
  fieldLabel?: string;
}

function formatCents(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}

/**
 * Parses a strict, unsigned dollar input and optionally validates its range.
 *
 * Returning a structured result lets browser forms provide immediate feedback
 * while server/domain boundaries can translate the same result into their own
 * error contract. The parser deliberately rejects prefixes, exponents, signs,
 * and sub-cent precision rather than relying on parseFloat coercion.
 */
export function validateDollarAmountInput(
  value: unknown,
  options: DollarAmountValidationOptions = {}
): DollarAmountValidationResult {
  const fieldLabel = options.fieldLabel ?? 'Amount';
  if (typeof value !== 'string') {
    return { valid: false, code: 'INVALID', message: 'Enter a valid dollar amount.' };
  }

  const normalized = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) {
    const hasSubCentPrecision = /^\d+\.\d{3,}$/.test(normalized);
    return {
      valid: false,
      code: hasSubCentPrecision ? 'PRECISION' : 'INVALID',
      message: hasSubCentPrecision
        ? 'Enter a dollar amount with no more than two decimal places.'
        : 'Enter a valid dollar amount.',
    };
  }

  const whole = Number(match[1]);
  const fractional = Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(whole) || whole > Math.floor(Number.MAX_SAFE_INTEGER / 100)) {
    return { valid: false, code: 'TOO_LARGE', message: 'Enter a smaller dollar amount.' };
  }

  const amountCents = whole * 100 + fractional;
  if (!Number.isSafeInteger(amountCents)) {
    return { valid: false, code: 'TOO_LARGE', message: 'Enter a smaller dollar amount.' };
  }

  if (options.minimumCents != null && amountCents < options.minimumCents) {
    return {
      valid: false,
      code: 'BELOW_MINIMUM',
      message: `${fieldLabel} must be at least ${formatCents(options.minimumCents)}.`,
    };
  }

  if (options.maximumCents != null && amountCents > options.maximumCents) {
    return {
      valid: false,
      code: 'ABOVE_MAXIMUM',
      message: `${fieldLabel} cannot exceed ${formatCents(options.maximumCents)}.`,
    };
  }

  return { valid: true, amountCents };
}
