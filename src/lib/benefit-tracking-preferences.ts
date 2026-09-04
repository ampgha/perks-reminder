import type { PrismaClient } from '@/generated/prisma';
import {
  fetchEffectiveBenefitStatuses,
  type EffectiveBenefitStatus,
  type EffectiveBenefitStatusFilters,
} from '@/lib/effective-benefit';
import {
  BenefitTrackingConfigurationError,
  benefitTrackingConfigurationsEqual,
  benefitTrackingKey,
  buildBenefitTrackingConfigurationMap,
  configurationFromPreference,
  excludeIgnoredBenefits,
  initialStatusFieldsForTrackingConfiguration,
  resolveBenefitTrackingConfiguration,
  validateBenefitTrackingConfiguration,
  type BenefitClaimSource,
  type BenefitTrackingConfiguration,
  type BenefitTrackingConfigurationMap,
  type BenefitTrackingPreferenceRecord,
  type BenefitTrackingTarget,
} from '@/lib/benefit-tracking-modes';

/**
 * The database-aware owner for cycle-independent tracking preferences.
 *
 * User-facing reads filter IGNORE here; repair and integrity readers continue
 * using the unfiltered effective-benefit owner. Materialization, window entry,
 * and explicit preference mutations all resolve amounts through the same pure
 * configuration owner.
 */

export type TrackingPreferenceDatabase = Pick<PrismaClient, 'benefitTrackingPreference'>;
type StatusReadDatabase = Pick<PrismaClient, '$queryRaw'>;

type PreferenceRow = BenefitTrackingPreferenceRecord & { userId: string };

const PREFERENCE_SELECT = {
  userId: true,
  creditCardId: true,
  predefinedBenefitId: true,
  benefitId: true,
  mode: true,
  autoClaimAmountCents: true,
} as const;

/** Complete tracking configurations for one user. */
export async function loadBenefitTrackingConfigurations(
  database: TrackingPreferenceDatabase,
  userId: string
): Promise<BenefitTrackingConfigurationMap> {
  const preferences = await database.benefitTrackingPreference.findMany({
    where: { userId, mode: { not: 'TRACK' } },
    select: PREFERENCE_SELECT,
  });
  return buildBenefitTrackingConfigurationMap(preferences);
}

/** Complete configurations for several users, isolated by owning user ID. */
export async function loadBenefitTrackingConfigurationsByUser(
  database: TrackingPreferenceDatabase,
  userIds: readonly string[]
): Promise<Map<string, BenefitTrackingConfigurationMap>> {
  const byUser = new Map<string, BenefitTrackingConfigurationMap>();
  if (userIds.length === 0) return byUser;

  const preferences = await database.benefitTrackingPreference.findMany({
    where: { userId: { in: [...userIds] }, mode: { not: 'TRACK' } },
    select: PREFERENCE_SELECT,
  });

  const grouped = new Map<string, PreferenceRow[]>();
  for (const preference of preferences) {
    const existing = grouped.get(preference.userId);
    if (existing) existing.push(preference);
    else grouped.set(preference.userId, [preference]);
  }
  grouped.forEach((rows, userId) => {
    byUser.set(userId, buildBenefitTrackingConfigurationMap(rows));
  });
  return byUser;
}

/** Canonical user-facing read: effective statuses minus IGNORE preferences. */
export async function fetchTrackedBenefitStatuses(
  database: StatusReadDatabase & TrackingPreferenceDatabase,
  filters: EffectiveBenefitStatusFilters
): Promise<EffectiveBenefitStatus[]> {
  const statuses = await fetchEffectiveBenefitStatuses(database, filters);
  if (statuses.length === 0) return statuses;

  if (filters.userIds) {
    const configurationsByUser = await loadBenefitTrackingConfigurationsByUser(
      database,
      filters.userIds
    );
    if (configurationsByUser.size === 0) return statuses;
    return statuses.filter(
      (status) => resolveBenefitTrackingConfiguration(
        configurationsByUser.get(status.userId),
        status
      ).mode !== 'IGNORE'
    );
  }

  const configurations = await loadBenefitTrackingConfigurations(database, filters.userId!);
  return excludeIgnoredBenefits(statuses, configurations);
}

/** A planned status insert, in the shape every materialization path produces. */
export interface PlannedStatusRow extends BenefitTrackingTarget {
  userId: string;
  cycleStartDate: Date;
}

export interface MaterializedStatusDefaults {
  isCompleted: boolean;
  completedAt: Date | null;
  usedAmount: number;
  claimSource: BenefitClaimSource | null;
}

/**
 * Resolve every planned insert against its owner's complete configuration.
 * Result order is exactly the input order so callers can zip fields onto rows.
 */
export async function applyTrackingModesToPlannedRows<T extends PlannedStatusRow>(
  database: TrackingPreferenceDatabase & Pick<PrismaClient, 'predefinedBenefit' | 'benefit'>,
  rows: readonly T[],
  now: Date = new Date()
): Promise<MaterializedStatusDefaults[]> {
  if (rows.length === 0) return [];

  const configurationsByUser = await loadBenefitTrackingConfigurationsByUser(
    database,
    Array.from(new Set(rows.map((row) => row.userId)))
  );
  if (configurationsByUser.size === 0) {
    return rows.map(() => ({
      isCompleted: false,
      completedAt: null,
      usedAmount: 0,
      claimSource: null,
    }));
  }

  const autoClaimRows = rows.filter((row) => (
    row.cycleStartDate.getTime() <= now.getTime()
    && resolveBenefitTrackingConfiguration(configurationsByUser.get(row.userId), row).mode
      === 'AUTO_CLAIM'
  ));
  const amounts = await loadClaimableAmounts(database, autoClaimRows);

  return rows.map((row) => {
    if (row.cycleStartDate.getTime() > now.getTime()) {
      return {
        isCompleted: false,
        completedAt: null,
        usedAmount: 0,
        claimSource: null,
      };
    }
    return initialStatusFieldsForTrackingConfiguration(
      resolveBenefitTrackingConfiguration(configurationsByUser.get(row.userId), row),
      amounts.get(benefitTrackingKey(row) ?? ''),
      now
    );
  });
}

/** Current tracked dollar maximum, keyed exactly like preferences. */
async function loadClaimableAmounts(
  database: Pick<PrismaClient, 'predefinedBenefit' | 'benefit'>,
  rows: readonly BenefitTrackingTarget[]
): Promise<Map<string, number | null>> {
  const amounts = new Map<string, number | null>();
  if (rows.length === 0) return amounts;

  const predefinedBenefitIds = Array.from(new Set(
    rows.map((row) => row.predefinedBenefitId).filter((id): id is string => Boolean(id))
  ));
  const benefitIds = Array.from(new Set(
    rows
      .filter((row) => !row.predefinedBenefitId)
      .map((row) => row.benefitId)
      .filter((id): id is string => Boolean(id))
  ));

  const [predefinedBenefits, benefits] = await Promise.all([
    predefinedBenefitIds.length > 0
      ? database.predefinedBenefit.findMany({
          where: { id: { in: predefinedBenefitIds } },
          select: { id: true, maxAmount: true },
        })
      : Promise.resolve([]),
    benefitIds.length > 0
      ? database.benefit.findMany({
          where: { id: { in: benefitIds } },
          select: { id: true, maxAmount: true },
        })
      : Promise.resolve([]),
  ]);

  const predefinedAmounts = new Map(predefinedBenefits.map((row) => [row.id, row.maxAmount]));
  const customAmounts = new Map(benefits.map((row) => [row.id, row.maxAmount]));
  for (const row of rows) {
    const key = benefitTrackingKey(row);
    if (key === null) continue;
    amounts.set(
      key,
      row.predefinedBenefitId
        ? predefinedAmounts.get(row.predefinedBenefitId) ?? null
        : customAmounts.get(row.benefitId ?? '') ?? null
    );
  }
  return amounts;
}

/** Claim pre-materialized virgin rows when their Benefit Cycle opens. */
export async function claimWindowEntryAutoClaims(
  database: TrackingPreferenceDatabase
    & Pick<PrismaClient, 'predefinedBenefit' | 'benefit' | 'benefitStatus'>,
  now: Date = new Date()
): Promise<number> {
  const preferences = await database.benefitTrackingPreference.findMany({
    where: { mode: 'AUTO_CLAIM' },
    select: PREFERENCE_SELECT,
  });
  if (preferences.length === 0) return 0;

  const amounts = await loadClaimableAmounts(database, preferences);
  let claimed = 0;
  for (const preference of preferences) {
    const key = benefitTrackingKey(preference);
    if (key === null) continue;
    const configuration = configurationFromPreference(preference);
    const fields = initialStatusFieldsForTrackingConfiguration(
      configuration,
      amounts.get(key),
      now
    );
    const result = await database.benefitStatus.updateMany({
      where: {
        userId: preference.userId,
        cycleStartDate: { lte: now },
        cycleEndDate: { gte: now },
        isCompleted: false,
        isNotUsable: false,
        usedAmount: 0,
        claimSource: null,
        ...(preference.predefinedBenefitId
          ? {
              creditCardId: preference.creditCardId,
              predefinedBenefitId: preference.predefinedBenefitId,
            }
          : { benefitId: preference.benefitId }),
      },
      data: fields,
    });
    claimed += result.count;
  }
  return claimed;
}

export interface BenefitTrackingMutationTarget {
  creditCardId: string | null;
  predefinedBenefitId: string | null;
  benefitId: string | null;
}

export interface ApplyBenefitTrackingConfigurationInput {
  userId: string;
  target: BenefitTrackingMutationTarget;
  maximumAmount: number | null | undefined;
  configuration: BenefitTrackingConfiguration;
  now?: Date;
  expectedPreferenceId?: string;
}

export type BenefitTrackingMutationDatabase = Pick<PrismaClient, '$transaction'>;

function validateMutationTarget(target: BenefitTrackingMutationTarget): void {
  const standard = Boolean(
    target.creditCardId && target.predefinedBenefitId && !target.benefitId
  );
  const custom = Boolean(
    target.benefitId && !target.creditCardId && !target.predefinedBenefitId
  );
  if (!standard && !custom) {
    throw new BenefitTrackingConfigurationError('Invalid benefit tracking target.');
  }
}

function persistenceAmount(configuration: BenefitTrackingConfiguration): number | null {
  return configuration.mode === 'AUTO_CLAIM' && configuration.value.kind === 'FIXED'
    ? configuration.value.amountCents
    : null;
}

/**
 * Persist a configuration and apply its exact open-cycle provenance transition
 * in one transaction. Both card and settings actions call this owner.
 */
export async function applyBenefitTrackingConfiguration(
  database: BenefitTrackingMutationDatabase,
  input: ApplyBenefitTrackingConfigurationInput
): Promise<BenefitTrackingConfiguration> {
  validateMutationTarget(input.target);
  validateBenefitTrackingConfiguration(input.configuration, input.maximumAmount);
  const now = input.now ?? new Date();

  return database.$transaction(async (transaction) => {
    const existing = await transaction.benefitTrackingPreference.findFirst({
      where: {
        userId: input.userId,
        ...input.target,
        ...(input.expectedPreferenceId ? { id: input.expectedPreferenceId } : {}),
      },
      select: {
        id: true,
        mode: true,
        autoClaimAmountCents: true,
        creditCardId: true,
        predefinedBenefitId: true,
        benefitId: true,
      },
    });

    if (input.expectedPreferenceId && !existing) {
      throw new BenefitTrackingConfigurationError(
        'Tracking preference not found or permission denied.'
      );
    }

    const previousConfiguration = configurationFromPreference(existing);
    const configurationChanged = !benefitTrackingConfigurationsEqual(
      previousConfiguration,
      input.configuration
    );

    if (configurationChanged) {
      if (input.configuration.mode === 'TRACK') {
        if (existing) {
          const deleted = await transaction.benefitTrackingPreference.deleteMany({
            where: { id: existing.id, userId: input.userId },
          });
          if (deleted.count !== 1) {
            throw new BenefitTrackingConfigurationError(
              'Tracking preference not found or permission denied.'
            );
          }
        }
      } else if (existing) {
        const updated = await transaction.benefitTrackingPreference.updateMany({
          where: { id: existing.id, userId: input.userId },
          data: {
            mode: input.configuration.mode,
            autoClaimAmountCents: persistenceAmount(input.configuration),
          },
        });
        if (updated.count !== 1) {
          throw new BenefitTrackingConfigurationError(
            'Tracking preference not found or permission denied.'
          );
        }
      } else {
        await transaction.benefitTrackingPreference.create({
          data: {
            userId: input.userId,
            ...input.target,
            mode: input.configuration.mode,
            autoClaimAmountCents: persistenceAmount(input.configuration),
          },
        });
      }
    }

    const openCycleWhere = {
      userId: input.userId,
      cycleStartDate: { lte: now },
      cycleEndDate: { gte: now },
      ...(input.target.predefinedBenefitId
        ? {
            creditCardId: input.target.creditCardId,
            predefinedBenefitId: input.target.predefinedBenefitId,
          }
        : { benefitId: input.target.benefitId }),
    };

    if (input.configuration.mode === 'AUTO_CLAIM' && configurationChanged) {
      const fields = initialStatusFieldsForTrackingConfiguration(
        input.configuration,
        input.maximumAmount,
        now
      );
      if (previousConfiguration.mode === 'AUTO_CLAIM') {
        await transaction.benefitStatus.updateMany({
          where: {
            ...openCycleWhere,
            OR: [
              { claimSource: 'AUTO' },
              {
                claimSource: null,
                isCompleted: false,
                isNotUsable: false,
                usedAmount: 0,
              },
            ],
          },
          data: { ...fields, isNotUsable: false },
        });
      } else {
        await transaction.benefitStatus.updateMany({
          where: { ...openCycleWhere, isCompleted: false },
          data: { ...fields, isNotUsable: false },
        });
      }
    }

    if (
      previousConfiguration.mode === 'AUTO_CLAIM'
      && input.configuration.mode !== 'AUTO_CLAIM'
    ) {
      await transaction.benefitStatus.updateMany({
        where: { ...openCycleWhere, isCompleted: true, claimSource: 'AUTO' },
        data: {
          isCompleted: false,
          completedAt: null,
          usedAmount: 0,
          claimSource: null,
        },
      });
    }

    return input.configuration;
  });
}
