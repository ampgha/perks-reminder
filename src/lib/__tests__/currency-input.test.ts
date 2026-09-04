import { validateDollarAmountInput } from '@/lib/currency-input';

describe('validateDollarAmountInput', () => {
  it.each([
    ['15', 1500],
    ['15.5', 1550],
    ['15.50', 1550],
    [' 0.01 ', 1],
  ])('parses %s into exact cents', (input, expectedCents) => {
    expect(validateDollarAmountInput(input)).toEqual({
      valid: true,
      amountCents: expectedCents,
    });
  });

  it('reports minimum and maximum violations with reusable field copy', () => {
    expect(validateDollarAmountInput('0', {
      minimumCents: 1,
      fieldLabel: 'Custom tracked value',
    })).toEqual({
      valid: false,
      code: 'BELOW_MINIMUM',
      message: 'Custom tracked value must be at least $0.01.',
    });

    expect(validateDollarAmountInput('25.01', {
      maximumCents: 2500,
      fieldLabel: 'Custom tracked value',
    })).toEqual({
      valid: false,
      code: 'ABOVE_MAXIMUM',
      message: 'Custom tracked value cannot exceed $25.00.',
    });
  });

  it.each([
    ['', 'INVALID'],
    ['abc', 'INVALID'],
    ['-1', 'INVALID'],
    ['1.001', 'PRECISION'],
  ])('rejects invalid input %s without coercion', (input, code) => {
    expect(validateDollarAmountInput(input)).toMatchObject({ valid: false, code });
  });
});
