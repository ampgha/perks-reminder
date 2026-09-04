import {
  BenefitTrackingConfigurationError,
  benefitTrackingConfigurationFormFields,
  benefitTrackingConfigurationsEqual,
  benefitTrackingKey,
  buildBenefitTrackingConfigurationMap,
  configurationFromPreference,
  excludeIgnoredBenefits,
  initialStatusFieldsForTrackingConfiguration,
  isBenefitTrackingMode,
  parseBenefitTrackingConfigurationInput,
  parseDollarAmountToCents,
  resolveAutoClaimValue,
  resolveBenefitTrackingConfiguration,
  summarizeBenefitTrackingConfiguration,
  validateBenefitTrackingConfiguration,
  type BenefitTrackingPreferenceRecord,
} from '@/lib/benefit-tracking-modes';

const NOW = new Date('2026-08-31T12:00:00.000Z');
const FULL = { mode: 'AUTO_CLAIM', value: { kind: 'FULL' } } as const;
const FIXED = { mode: 'AUTO_CLAIM', value: { kind: 'FIXED', amountCents: 1500 } } as const;

describe('benefitTrackingKey', () => {
  it('keys standard benefits by physical card and predefined benefit', () => {
    expect(
      benefitTrackingKey({ creditCardId: 'card_1', predefinedBenefitId: 'pb_1', benefitId: null })
    ).toBe('standard:card_1:pb_1');
  });

  it('keys custom benefits by their own id', () => {
    expect(
      benefitTrackingKey({ creditCardId: null, predefinedBenefitId: null, benefitId: 'b_1' })
    ).toBe('custom:b_1');
  });

  it('prefers predefined identity for bridge rows and separates physical cards', () => {
    expect(
      benefitTrackingKey({
        creditCardId: 'card_1',
        predefinedBenefitId: 'pb_1',
        benefitId: 'legacy_1',
      })
    ).toBe('standard:card_1:pb_1');
    expect(benefitTrackingKey({ creditCardId: 'card_1', predefinedBenefitId: 'pb_1' }))
      .not.toBe(benefitTrackingKey({ creditCardId: 'card_2', predefinedBenefitId: 'pb_1' }));
  });

  it('returns null when no benefit is identified', () => {
    expect(benefitTrackingKey({ creditCardId: 'card_1' })).toBeNull();
  });
});

describe('persistence normalization and configuration maps', () => {
  const preferences: BenefitTrackingPreferenceRecord[] = [
    {
      creditCardId: 'card_1',
      predefinedBenefitId: 'pb_full',
      benefitId: null,
      mode: 'AUTO_CLAIM',
      autoClaimAmountCents: null,
    },
    {
      creditCardId: 'card_1',
      predefinedBenefitId: 'pb_fixed',
      benefitId: null,
      mode: 'AUTO_CLAIM',
      autoClaimAmountCents: 1500,
    },
    {
      creditCardId: null,
      predefinedBenefitId: null,
      benefitId: 'custom_1',
      mode: 'IGNORE',
      autoClaimAmountCents: null,
    },
  ];

  it('keeps null auto amounts backward compatible as dynamic full value', () => {
    expect(configurationFromPreference(preferences[0])).toEqual(FULL);
    expect(configurationFromPreference(preferences[1])).toEqual(FIXED);
    expect(configurationFromPreference(undefined)).toEqual({ mode: 'TRACK' });
  });

  it('indexes the complete configuration and defaults missing benefits to TRACK', () => {
    const configurations = buildBenefitTrackingConfigurationMap(preferences);
    expect(configurations.get('standard:card_1:pb_full')).toEqual(FULL);
    expect(configurations.get('standard:card_1:pb_fixed')).toEqual(FIXED);
    expect(
      resolveBenefitTrackingConfiguration(configurations, {
        creditCardId: 'card_1',
        predefinedBenefitId: 'missing',
      })
    ).toEqual({ mode: 'TRACK' });
  });

  it('omits TRACK and unidentifiable rows', () => {
    const configurations = buildBenefitTrackingConfigurationMap([
      ...preferences,
      { creditCardId: 'card_9', predefinedBenefitId: 'pb_9', mode: 'TRACK' },
      { creditCardId: 'card_8', mode: 'IGNORE' },
    ]);
    expect(configurations.size).toBe(3);
  });

  it('fails closed for impossible persisted amount combinations', () => {
    expect(() => configurationFromPreference({
      creditCardId: null,
      predefinedBenefitId: null,
      benefitId: 'custom_1',
      mode: 'IGNORE',
      autoClaimAmountCents: 100,
    })).toThrow(BenefitTrackingConfigurationError);
    expect(() => configurationFromPreference({
      creditCardId: null,
      predefinedBenefitId: null,
      benefitId: 'custom_1',
      mode: 'AUTO_CLAIM',
      autoClaimAmountCents: 0,
    })).toThrow('positive whole number of cents');
    expect(() => configurationFromPreference({
      creditCardId: null,
      predefinedBenefitId: null,
      benefitId: 'custom_1',
      mode: 'AUTO_CLAIM',
      autoClaimAmountCents: 2_147_483_648,
    })).toThrow('positive whole number of cents');
  });
});

describe('excludeIgnoredBenefits', () => {
  const configurations = buildBenefitTrackingConfigurationMap([
    { creditCardId: 'card_1', predefinedBenefitId: 'ignored', mode: 'IGNORE' },
    { creditCardId: 'card_1', predefinedBenefitId: 'auto', mode: 'AUTO_CLAIM' },
  ]);

  it('drops ignored benefits while keeping full/fixed auto and default tracking', () => {
    const rows = [
      { creditCardId: 'card_1', predefinedBenefitId: 'ignored' },
      { creditCardId: 'card_1', predefinedBenefitId: 'auto' },
      { creditCardId: 'card_1', predefinedBenefitId: 'tracked' },
    ];
    expect(excludeIgnoredBenefits(rows, configurations).map((row) => row.predefinedBenefitId))
      .toEqual(['auto', 'tracked']);
  });
});

describe('strict amount and form parsing', () => {
  it.each([
    ['15', 1500],
    ['15.5', 1550],
    ['15.50', 1550],
    ['0.01', 1],
  ])('parses %s as exact cents', (value, cents) => {
    expect(parseDollarAmountToCents(value)).toBe(cents);
  });

  it('stays within the exact PostgreSQL INTEGER persistence range', () => {
    expect(parseDollarAmountToCents('21474836.47')).toBe(2_147_483_647);
    expect(() => parseDollarAmountToCents('21474836.48')).toThrow('smaller dollar amount');
  });

  it.each(['', '0', '0.00', '-1', '1.001', '15abc', '1e2', '01.00', 'Infinity', 'NaN'])
  ('rejects malformed or non-positive input %s', (value) => {
    expect(() => parseDollarAmountToCents(value)).toThrow(BenefitTrackingConfigurationError);
  });

  it('parses the complete legal form vocabulary', () => {
    expect(parseBenefitTrackingConfigurationInput({ trackingMode: 'TRACK' }))
      .toEqual({ mode: 'TRACK' });
    expect(parseBenefitTrackingConfigurationInput({ trackingMode: 'IGNORE' }))
      .toEqual({ mode: 'IGNORE' });
    expect(parseBenefitTrackingConfigurationInput({
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FULL',
    })).toEqual(FULL);
    expect(parseBenefitTrackingConfigurationInput({
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FIXED',
      autoClaimAmount: '15.00',
    })).toEqual(FIXED);
  });

  it('rejects unknown and contradictory semantic combinations', () => {
    expect(() => parseBenefitTrackingConfigurationInput({ trackingMode: 'DROP_TABLE' }))
      .toThrow('Unknown benefit tracking mode');
    expect(() => parseBenefitTrackingConfigurationInput({ trackingMode: 'AUTO_CLAIM' }))
      .toThrow('Choose full or custom');
    expect(() => parseBenefitTrackingConfigurationInput({
      trackingMode: 'TRACK',
      autoClaimValueKind: 'FULL',
    })).toThrow('only valid for automatic claiming');
    expect(() => parseBenefitTrackingConfigurationInput({
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FULL',
      autoClaimAmount: '15',
    })).toThrow('cannot be submitted with full');
  });

  it('serializes only fields legal for the chosen configuration', () => {
    expect(benefitTrackingConfigurationFormFields({ mode: 'IGNORE' }))
      .toEqual({ trackingMode: 'IGNORE' });
    expect(benefitTrackingConfigurationFormFields(FULL)).toEqual({
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FULL',
    });
    expect(benefitTrackingConfigurationFormFields(FIXED)).toEqual({
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FIXED',
      autoClaimAmount: '15.00',
    });
  });
});

describe('automatic value resolution', () => {
  it('uses the current maximum for full value and a stable amount for fixed value', () => {
    expect(resolveAutoClaimValue(FULL, 25)).toEqual({
      configuredAmountCents: null,
      effectiveAmountCents: 2500,
      wasCapped: false,
      hasTrackedDollarValue: true,
    });
    expect(resolveAutoClaimValue(FIXED, 25).effectiveAmountCents).toBe(1500);
    expect(resolveAutoClaimValue(FIXED, 40).effectiveAmountCents).toBe(1500);
  });

  it('normalizes definition floats to cents and treats non-positive/non-finite values as zero', () => {
    expect(resolveAutoClaimValue(FULL, 12.344).effectiveAmountCents).toBe(1234);
    expect(resolveAutoClaimValue(FULL, 12.346).effectiveAmountCents).toBe(1235);
    expect(resolveAutoClaimValue(FULL, Number.NaN).effectiveAmountCents).toBe(0);
    expect(resolveAutoClaimValue(FULL, Number.POSITIVE_INFINITY).effectiveAmountCents).toBe(0);
    expect(resolveAutoClaimValue(FULL, -1).effectiveAmountCents).toBe(0);
  });

  it('caps a stale fixed choice without rewriting the configured amount', () => {
    expect(resolveAutoClaimValue(FIXED, 10)).toEqual({
      configuredAmountCents: 1500,
      effectiveAmountCents: 1000,
      wasCapped: true,
      hasTrackedDollarValue: true,
    });
    expect(resolveAutoClaimValue(FIXED, 0)).toEqual({
      configuredAmountCents: 1500,
      effectiveAmountCents: 0,
      wasCapped: true,
      hasTrackedDollarValue: false,
    });
  });

  it('rejects a new fixed choice above or without a current maximum', () => {
    expect(() => validateBenefitTrackingConfiguration(FIXED, 10))
      .toThrow('cannot exceed $10.00');
    expect(() => validateBenefitTrackingConfiguration(FIXED, 0))
      .toThrow('no tracked dollar value');
    expect(validateBenefitTrackingConfiguration(FIXED, 25)).toBe(FIXED);
  });
});

describe('status defaults and summaries', () => {
  it('leaves normal and ignored cycles unclaimed', () => {
    expect(initialStatusFieldsForTrackingConfiguration({ mode: 'TRACK' }, 25, NOW)).toEqual({
      isCompleted: false,
      completedAt: null,
      usedAmount: 0,
      claimSource: null,
    });
    expect(initialStatusFieldsForTrackingConfiguration({ mode: 'IGNORE' }, 25, NOW))
      .toEqual(initialStatusFieldsForTrackingConfiguration({ mode: 'TRACK' }, 25, NOW));
  });

  it('closes full, fixed, capped, and zero-value automatic cycles', () => {
    expect(initialStatusFieldsForTrackingConfiguration(FULL, 25, NOW)).toEqual({
      isCompleted: true,
      completedAt: NOW,
      usedAmount: 25,
      claimSource: 'AUTO',
    });
    expect(initialStatusFieldsForTrackingConfiguration(FIXED, 25, NOW).usedAmount).toBe(15);
    expect(initialStatusFieldsForTrackingConfiguration(FIXED, 10, NOW).usedAmount).toBe(10);
    expect(initialStatusFieldsForTrackingConfiguration(FULL, null, NOW).usedAmount).toBe(0);
  });

  it('makes full, fixed, per-occurrence, and zero-value state visible', () => {
    expect(summarizeBenefitTrackingConfiguration({ configuration: FULL, maxAmount: 25 }))
      .toBe('Auto: full ($25.00)');
    expect(summarizeBenefitTrackingConfiguration({ configuration: FIXED, maxAmount: 25 }))
      .toBe('Auto: $15.00/cycle');
    expect(summarizeBenefitTrackingConfiguration({
      configuration: FIXED,
      maxAmount: 25,
      occurrencesInCycle: 2,
    })).toBe('Auto: $15.00/occurrence');
    expect(summarizeBenefitTrackingConfiguration({ configuration: FULL, maxAmount: 0 }))
      .toBe('Auto: claimed');
  });

  it('compares nested configurations exhaustively', () => {
    expect(benefitTrackingConfigurationsEqual(FULL, FULL)).toBe(true);
    expect(benefitTrackingConfigurationsEqual(FULL, FIXED)).toBe(false);
    expect(benefitTrackingConfigurationsEqual(FIXED, { ...FIXED })).toBe(true);
    expect(benefitTrackingConfigurationsEqual(FIXED, {
      mode: 'AUTO_CLAIM',
      value: { kind: 'FIXED', amountCents: 1600 },
    })).toBe(false);
  });
});

describe('isBenefitTrackingMode', () => {
  it('accepts only the three top-level modes', () => {
    expect(isBenefitTrackingMode('TRACK')).toBe(true);
    expect(isBenefitTrackingMode('AUTO_CLAIM')).toBe(true);
    expect(isBenefitTrackingMode('IGNORE')).toBe(true);
    expect(isBenefitTrackingMode('AUTO_CLAIM_PARTIAL')).toBe(false);
  });
});
