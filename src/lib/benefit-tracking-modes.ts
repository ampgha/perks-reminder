/**
 * Pure, client-safe ownership for cycle-independent benefit tracking.
 *
 * `isNotUsable` on BenefitStatus only describes one Benefit Cycle, so a benefit
 * the user always uses (or never wants to see) has to be re-confirmed every
 * cycle. These preferences live outside the cycle instead:
 *
 * - `TRACK` keeps the original per-cycle workflow and is the default whenever
 *   no preference row exists.
 * - `AUTO_CLAIM` materializes each new cycle already claimed, so the benefit
 *   leaves the to-do list but still counts toward claimed value and ROI.
 * - `IGNORE` moves the benefit to the dashboard's Ignored tab and excludes it
 *   from tracked tabs, claimed value, and ROI.
 *
 * Every function here is pure so the behaviour can be tested without a
 * database. Completion and claimed dollar value are deliberately separate:
 * AUTO_CLAIM always closes the Benefit Cycle, while its nested value choice
 * determines how much that occurrence contributes to claimed value and ROI.
 */
import type {
  BenefitStatusClaimSource,
  BenefitTrackingMode as PersistedBenefitTrackingMode,
} from '@/generated/prisma';
import { validateDollarAmountInput } from '@/lib/currency-input';

export type BenefitTrackingMode = PersistedBenefitTrackingMode;
export type AutoClaimValueKind = 'FULL' | 'FIXED';

export const BENEFIT_TRACKING_MODES: readonly BenefitTrackingMode[] = [
  'TRACK',
  'AUTO_CLAIM',
  'IGNORE',
] as const;

export const AUTO_CLAIM_VALUE_KINDS: readonly AutoClaimValueKind[] = [
  'FULL',
  'FIXED',
] as const;

export const DEFAULT_BENEFIT_TRACKING_MODE: BenefitTrackingMode = 'TRACK';

// Prisma `Int` maps to PostgreSQL INTEGER. Keep form/domain validation inside
// the exact persistence range so an otherwise valid large value cannot fail as
// an opaque database error.
const MAX_PERSISTED_AUTO_CLAIM_AMOUNT_CENTS = 2_147_483_647;

export type BenefitTrackingConfiguration =
  | { mode: 'TRACK' }
  | { mode: 'IGNORE' }
  | { mode: 'AUTO_CLAIM'; value: { kind: 'FULL' } }
  | { mode: 'AUTO_CLAIM'; value: { kind: 'FIXED'; amountCents: number } };

export type AutoClaimConfiguration = Extract<
  BenefitTrackingConfiguration,
  { mode: 'AUTO_CLAIM' }
>;

export const DEFAULT_BENEFIT_TRACKING_CONFIGURATION: BenefitTrackingConfiguration = {
  mode: 'TRACK',
};

export class BenefitTrackingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenefitTrackingConfigurationError';
  }
}

export function isBenefitTrackingMode(value: unknown): value is BenefitTrackingMode {
  return typeof value === 'string'
    && (BENEFIT_TRACKING_MODES as readonly string[]).includes(value);
}

export function isAutoClaimValueKind(value: unknown): value is AutoClaimValueKind {
  return typeof value === 'string'
    && (AUTO_CLAIM_VALUE_KINDS as readonly string[]).includes(value);
}

/** The standard/custom address used by BenefitStatus and materialization. */
export interface BenefitTrackingTarget {
  creditCardId?: string | null;
  predefinedBenefitId?: string | null;
  benefitId?: string | null;
}

export interface BenefitTrackingPreferenceRecord extends BenefitTrackingTarget {
  mode: BenefitTrackingMode;
  autoClaimAmountCents?: number | null;
}

export type BenefitTrackingConfigurationMap = ReadonlyMap<
  string,
  BenefitTrackingConfiguration
>;

/**
 * Standard benefits are keyed by physical card plus global definition. Bridge
 * rows carry a legacy benefitId too, so predefined identity wins. Custom
 * benefits are keyed by their own definition ID.
 */
export function benefitTrackingKey(target: BenefitTrackingTarget): string | null {
  if (target.predefinedBenefitId) {
    return `standard:${target.creditCardId ?? ''}:${target.predefinedBenefitId}`;
  }
  if (target.benefitId) {
    return `custom:${target.benefitId}`;
  }
  return null;
}

/** Convert one persisted row into the complete domain configuration. */
export function configurationFromPreference(
  preference: BenefitTrackingPreferenceRecord | null | undefined
): BenefitTrackingConfiguration {
  if (!preference) return DEFAULT_BENEFIT_TRACKING_CONFIGURATION;

  const cents = preference.autoClaimAmountCents;
  if (preference.mode === 'TRACK') {
    if (cents != null) {
      throw new BenefitTrackingConfigurationError(
        'A normal-tracking preference cannot contain an automatic claim amount.'
      );
    }
    return { mode: 'TRACK' };
  }
  if (preference.mode === 'IGNORE') {
    if (cents != null) {
      throw new BenefitTrackingConfigurationError(
        'An ignored preference cannot contain an automatic claim amount.'
      );
    }
    return { mode: 'IGNORE' };
  }
  if (preference.mode !== 'AUTO_CLAIM') {
    throw new BenefitTrackingConfigurationError('Unknown stored benefit tracking mode.');
  }
  if (cents == null) {
    return { mode: 'AUTO_CLAIM', value: { kind: 'FULL' } };
  }
  if (
    !Number.isSafeInteger(cents)
    || cents <= 0
    || cents > MAX_PERSISTED_AUTO_CLAIM_AMOUNT_CENTS
  ) {
    throw new BenefitTrackingConfigurationError(
      'A fixed automatic claim amount must be a positive whole number of cents.'
    );
  }
  return { mode: 'AUTO_CLAIM', value: { kind: 'FIXED', amountCents: cents } };
}

export function buildBenefitTrackingConfigurationMap(
  preferences: readonly BenefitTrackingPreferenceRecord[]
): Map<string, BenefitTrackingConfiguration> {
  const configurations = new Map<string, BenefitTrackingConfiguration>();
  for (const preference of preferences) {
    const key = benefitTrackingKey(preference);
    const configuration = configurationFromPreference(preference);
    if (key === null || configuration.mode === DEFAULT_BENEFIT_TRACKING_MODE) continue;
    configurations.set(key, configuration);
  }
  return configurations;
}

export function resolveBenefitTrackingConfiguration(
  configurations: BenefitTrackingConfigurationMap | undefined,
  target: BenefitTrackingTarget
): BenefitTrackingConfiguration {
  if (!configurations || configurations.size === 0) {
    return DEFAULT_BENEFIT_TRACKING_CONFIGURATION;
  }
  const key = benefitTrackingKey(target);
  if (key === null) return DEFAULT_BENEFIT_TRACKING_CONFIGURATION;
  return configurations.get(key) ?? DEFAULT_BENEFIT_TRACKING_CONFIGURATION;
}

/**
 * Drops the benefits the user chose to ignore from tracked projections. The
 * dashboard keeps a separate Ignored tab for review and restoration.
 */
export function excludeIgnoredBenefits<T extends BenefitTrackingTarget>(
  rows: readonly T[],
  configurations: BenefitTrackingConfigurationMap | undefined
): T[] {
  if (!configurations || configurations.size === 0) return [...rows];
  return rows.filter(
    (row) => resolveBenefitTrackingConfiguration(configurations, row).mode !== 'IGNORE'
  );
}

export function benefitTrackingConfigurationsEqual(
  left: BenefitTrackingConfiguration,
  right: BenefitTrackingConfiguration
): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode !== 'AUTO_CLAIM' || right.mode !== 'AUTO_CLAIM') return true;
  if (left.value.kind !== right.value.kind) return false;
  return left.value.kind === 'FULL'
    || (right.value.kind === 'FIXED' && left.value.amountCents === right.value.amountCents);
}

/** Strictly parse an entered USD decimal without parseFloat-style prefixes. */
export function parseDollarAmountToCents(value: unknown): number {
  const result = validateDollarAmountInput(value, {
    minimumCents: 1,
    maximumCents: MAX_PERSISTED_AUTO_CLAIM_AMOUNT_CENTS,
    fieldLabel: 'Custom tracked value',
  });
  if (!result.valid) {
    let message = result.message;
    if (result.code === 'ABOVE_MAXIMUM') {
      message = 'Enter a smaller dollar amount.';
    } else if (result.code === 'INVALID' && typeof value === 'string') {
      // Preserve the existing server-action error contract for malformed form input.
      message = 'Enter a dollar amount with no more than two decimal places.';
    }
    throw new BenefitTrackingConfigurationError(message);
  }
  return result.amountCents;
}

export function parseBenefitTrackingConfigurationInput(input: {
  trackingMode: unknown;
  autoClaimValueKind?: unknown;
  autoClaimAmount?: unknown;
}): BenefitTrackingConfiguration {
  if (!isBenefitTrackingMode(input.trackingMode)) {
    throw new BenefitTrackingConfigurationError('Unknown benefit tracking mode.');
  }

  const hasValueKind = input.autoClaimValueKind != null && input.autoClaimValueKind !== '';
  const hasAmount = input.autoClaimAmount != null && input.autoClaimAmount !== '';
  if (input.trackingMode !== 'AUTO_CLAIM') {
    if (hasValueKind || hasAmount) {
      throw new BenefitTrackingConfigurationError(
        'Automatic claim value fields are only valid for automatic claiming.'
      );
    }
    return { mode: input.trackingMode };
  }

  if (!isAutoClaimValueKind(input.autoClaimValueKind)) {
    throw new BenefitTrackingConfigurationError('Choose full or custom tracked value.');
  }
  if (input.autoClaimValueKind === 'FULL') {
    if (hasAmount) {
      throw new BenefitTrackingConfigurationError(
        'A custom amount cannot be submitted with full tracked value.'
      );
    }
    return { mode: 'AUTO_CLAIM', value: { kind: 'FULL' } };
  }
  return {
    mode: 'AUTO_CLAIM',
    value: {
      kind: 'FIXED',
      amountCents: parseDollarAmountToCents(input.autoClaimAmount),
    },
  };
}

export function benefitTrackingConfigurationFormFields(
  configuration: BenefitTrackingConfiguration
): Readonly<Record<string, string>> {
  if (configuration.mode !== 'AUTO_CLAIM') {
    return { trackingMode: configuration.mode };
  }
  if (configuration.value.kind === 'FULL') {
    return { trackingMode: 'AUTO_CLAIM', autoClaimValueKind: 'FULL' };
  }
  return {
    trackingMode: 'AUTO_CLAIM',
    autoClaimValueKind: 'FIXED',
    autoClaimAmount: (configuration.value.amountCents / 100).toFixed(2),
  };
}

export function normalizeTrackedMaximumCents(maxAmount: number | null | undefined): number {
  if (typeof maxAmount !== 'number' || !Number.isFinite(maxAmount) || maxAmount <= 0) {
    return 0;
  }
  const cents = Math.round(maxAmount * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : 0;
}

export interface ResolvedAutoClaimValue {
  configuredAmountCents: number | null;
  effectiveAmountCents: number;
  wasCapped: boolean;
  hasTrackedDollarValue: boolean;
}

export function resolveAutoClaimValue(
  configuration: AutoClaimConfiguration,
  maxAmount: number | null | undefined
): ResolvedAutoClaimValue {
  const maximumCents = normalizeTrackedMaximumCents(maxAmount);
  const configuredAmountCents = configuration.value.kind === 'FIXED'
    ? configuration.value.amountCents
    : null;
  return {
    configuredAmountCents,
    effectiveAmountCents: configuredAmountCents === null
      ? maximumCents
      : Math.min(configuredAmountCents, maximumCents),
    wasCapped: configuredAmountCents !== null && configuredAmountCents > maximumCents,
    hasTrackedDollarValue: maximumCents > 0,
  };
}

export function validateBenefitTrackingConfiguration(
  configuration: BenefitTrackingConfiguration,
  maxAmount: number | null | undefined
): BenefitTrackingConfiguration {
  if (configuration.mode !== 'AUTO_CLAIM' || configuration.value.kind !== 'FIXED') {
    return configuration;
  }
  if (
    !Number.isSafeInteger(configuration.value.amountCents)
    || configuration.value.amountCents <= 0
    || configuration.value.amountCents > MAX_PERSISTED_AUTO_CLAIM_AMOUNT_CENTS
  ) {
    throw new BenefitTrackingConfigurationError('Enter a valid fixed tracked value.');
  }
  const maximumCents = normalizeTrackedMaximumCents(maxAmount);
  if (maximumCents === 0) {
    throw new BenefitTrackingConfigurationError(
      'This benefit has no tracked dollar value. Use automatic claimed status instead.'
    );
  }
  if (configuration.value.amountCents > maximumCents) {
    throw new BenefitTrackingConfigurationError(
      `Custom tracked value cannot exceed ${formatTrackedCurrency(maximumCents)}.`
    );
  }
  return configuration;
}

export function formatTrackedCurrency(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}

export function summarizeBenefitTrackingConfiguration(input: {
  configuration: BenefitTrackingConfiguration;
  maxAmount: number | null | undefined;
  occurrencesInCycle?: number | null;
}): string {
  const { configuration } = input;
  if (configuration.mode === 'TRACK') return 'Tracking';
  if (configuration.mode === 'IGNORE') return 'Ignored';

  const resolved = resolveAutoClaimValue(configuration, input.maxAmount);
  if (!resolved.hasTrackedDollarValue) return 'Auto: claimed';
  if (configuration.value.kind === 'FULL') {
    return `Auto: full (${formatTrackedCurrency(resolved.effectiveAmountCents)})`;
  }
  const cadence = (input.occurrencesInCycle ?? 1) > 1 ? 'occurrence' : 'cycle';
  return `Auto: ${formatTrackedCurrency(configuration.value.amountCents)}/${cadence}`;
}

/** Who last set a status row's claim state. */
export type BenefitClaimSource = BenefitStatusClaimSource;

export interface AutoClaimStatusFields {
  isCompleted: boolean;
  completedAt: Date | null;
  usedAmount: number;
  claimSource: BenefitClaimSource | null;
}

/** Resolve the initial status fields for any materialized/configured cycle. */
export function initialStatusFieldsForTrackingConfiguration(
  configuration: BenefitTrackingConfiguration,
  maxAmount: number | null | undefined,
  now: Date
): AutoClaimStatusFields {
  if (configuration.mode !== 'AUTO_CLAIM') {
    return { isCompleted: false, completedAt: null, usedAmount: 0, claimSource: null };
  }
  const resolved = resolveAutoClaimValue(configuration, maxAmount);
  return {
    isCompleted: true,
    completedAt: now,
    usedAmount: resolved.effectiveAmountCents / 100,
    claimSource: 'AUTO',
  };
}
