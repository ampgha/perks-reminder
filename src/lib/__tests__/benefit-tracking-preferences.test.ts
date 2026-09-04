jest.mock('@/lib/effective-benefit', () => ({
  fetchEffectiveBenefitStatuses: jest.fn(),
}));

import {
  applyBenefitTrackingConfiguration,
  applyTrackingModesToPlannedRows,
  claimWindowEntryAutoClaims,
  fetchTrackedBenefitStatuses,
  loadBenefitTrackingConfigurations,
  loadBenefitTrackingConfigurationsByUser,
} from '@/lib/benefit-tracking-preferences';
import { fetchEffectiveBenefitStatuses } from '@/lib/effective-benefit';

const mockFetchStatuses = fetchEffectiveBenefitStatuses as jest.Mock;
const NOW = new Date('2026-08-31T12:00:00.000Z');

function database(
  preferences: unknown[] = [],
  amounts: {
    predefined?: Array<{ id: string; maxAmount: number | null }>;
    custom?: Array<{ id: string; maxAmount: number | null }>;
  } = {},
  existingPreference: unknown = null
) {
  const db = {
    benefitTrackingPreference: {
      findMany: jest.fn().mockResolvedValue(preferences),
      findFirst: jest.fn().mockResolvedValue(existingPreference),
      create: jest.fn().mockResolvedValue({ id: 'created-pref' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    predefinedBenefit: { findMany: jest.fn().mockResolvedValue(amounts.predefined ?? []) },
    benefit: { findMany: jest.fn().mockResolvedValue(amounts.custom ?? []) },
    benefitStatus: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (callback: (transaction: typeof db) => unknown) => (
    callback(db)
  ));
  return db as never;
}

const standardPreference = (overrides = {}) => ({
  id: 'pref-1',
  userId: 'user-1',
  creditCardId: 'card-1',
  predefinedBenefitId: 'pb-1',
  benefitId: null,
  mode: 'IGNORE',
  autoClaimAmountCents: null,
  ...overrides,
});

const plannedStandard = (overrides = {}) => ({
  userId: 'user-1',
  creditCardId: 'card-1',
  predefinedBenefitId: 'pb-1',
  benefitId: null,
  ...overrides,
});

const standardTarget = {
  creditCardId: 'card-1',
  predefinedBenefitId: 'pb-1',
  benefitId: null,
};

function preferenceDelegate(db: unknown) {
  return (db as {
    benefitTrackingPreference: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
  }).benefitTrackingPreference;
}

function statusUpdateMany(db: unknown) {
  return (db as { benefitStatus: { updateMany: jest.Mock } }).benefitStatus.updateMany;
}

beforeEach(() => jest.clearAllMocks());

describe('configuration loading', () => {
  it('loads full and fixed configurations for the owning user', async () => {
    const db = database([
      standardPreference({ mode: 'AUTO_CLAIM' }),
      standardPreference({
        predefinedBenefitId: 'pb-2',
        mode: 'AUTO_CLAIM',
        autoClaimAmountCents: 1500,
      }),
    ]);

    const configurations = await loadBenefitTrackingConfigurations(db, 'user-1');

    expect(configurations.get('standard:card-1:pb-1')).toEqual({
      mode: 'AUTO_CLAIM',
      value: { kind: 'FULL' },
    });
    expect(configurations.get('standard:card-1:pb-2')).toEqual({
      mode: 'AUTO_CLAIM',
      value: { kind: 'FIXED', amountCents: 1500 },
    });
    expect(preferenceDelegate(db).findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1', mode: { not: 'TRACK' } },
      select: expect.objectContaining({ autoClaimAmountCents: true }),
    }));
  });

  it('keeps identical benefit keys isolated by owning user', async () => {
    const db = database([
      standardPreference({ userId: 'user-1', mode: 'IGNORE' }),
      standardPreference({
        userId: 'user-2',
        mode: 'AUTO_CLAIM',
        autoClaimAmountCents: 500,
      }),
    ]);

    const byUser = await loadBenefitTrackingConfigurationsByUser(db, ['user-1', 'user-2']);

    expect(byUser.get('user-1')!.get('standard:card-1:pb-1')).toEqual({ mode: 'IGNORE' });
    expect(byUser.get('user-2')!.get('standard:card-1:pb-1')).toEqual({
      mode: 'AUTO_CLAIM',
      value: { kind: 'FIXED', amountCents: 500 },
    });
  });

  it('does not query an empty user list', async () => {
    const db = database();
    expect(await loadBenefitTrackingConfigurationsByUser(db, [])).toEqual(new Map());
    expect(preferenceDelegate(db).findMany).not.toHaveBeenCalled();
  });
});

describe('fetchTrackedBenefitStatuses', () => {
  const status = (overrides = {}) => ({
    id: 'status-1',
    userId: 'user-1',
    benefitId: 'bridge-1',
    creditCardId: 'card-1',
    predefinedBenefitId: 'pb-1',
    ...overrides,
  });

  it('removes ignored rows and retains automatic rows for ROI', async () => {
    mockFetchStatuses.mockResolvedValue([
      status({ id: 'ignored' }),
      status({ id: 'auto', predefinedBenefitId: 'pb-2' }),
    ]);
    const db = database([standardPreference({ mode: 'IGNORE' })]);

    const result = await fetchTrackedBenefitStatuses(db, { userId: 'user-1' });

    expect(result.map((row) => row.id)).toEqual(['auto']);
  });

  it('resolves each multi-user row against its own owner', async () => {
    mockFetchStatuses.mockResolvedValue([
      status({ id: 'user-1-row', userId: 'user-1' }),
      status({ id: 'user-2-row', userId: 'user-2' }),
    ]);
    const db = database([standardPreference({ userId: 'user-1', mode: 'IGNORE' })]);

    const result = await fetchTrackedBenefitStatuses(db, {
      userIds: ['user-1', 'user-2'],
    });

    expect(result.map((row) => row.id)).toEqual(['user-2-row']);
  });

  it('skips preferences when the effective read is empty', async () => {
    mockFetchStatuses.mockResolvedValue([]);
    const db = database([standardPreference()]);
    await fetchTrackedBenefitStatuses(db, { userId: 'user-1' });
    expect(preferenceDelegate(db).findMany).not.toHaveBeenCalled();
  });
});

describe('applyTrackingModesToPlannedRows', () => {
  it('materializes full and fixed automatic values in input order', async () => {
    const db = database(
      [
        standardPreference({ mode: 'AUTO_CLAIM' }),
        standardPreference({
          predefinedBenefitId: 'pb-2',
          mode: 'AUTO_CLAIM',
          autoClaimAmountCents: 1500,
        }),
      ],
      { predefined: [
        { id: 'pb-1', maxAmount: 25 },
        { id: 'pb-2', maxAmount: 25 },
      ] }
    );

    const defaults = await applyTrackingModesToPlannedRows(db, [
      plannedStandard({ predefinedBenefitId: 'pb-1' }),
      plannedStandard({ predefinedBenefitId: 'pb-2' }),
      plannedStandard({ predefinedBenefitId: 'pb-3' }),
    ], NOW);

    expect(defaults.map((row) => [row.isCompleted, row.usedAmount]))
      .toEqual([[true, 25], [true, 15], [false, 0]]);
    expect(defaults[0].claimSource).toBe('AUTO');
  });

  it('caps stale fixed configuration at the current maximum', async () => {
    const db = database(
      [standardPreference({ mode: 'AUTO_CLAIM', autoClaimAmountCents: 1500 })],
      { predefined: [{ id: 'pb-1', maxAmount: 10 }] }
    );
    const [defaults] = await applyTrackingModesToPlannedRows(db, [plannedStandard()], NOW);
    expect(defaults).toEqual({
      isCompleted: true,
      completedAt: NOW,
      usedAmount: 10,
      claimSource: 'AUTO',
    });
  });

  it('supports fixed custom benefits and zero-value binary automatic claims', async () => {
    const fixedDb = database(
      [standardPreference({
        creditCardId: null,
        predefinedBenefitId: null,
        benefitId: 'custom-1',
        mode: 'AUTO_CLAIM',
        autoClaimAmountCents: 1250,
      })],
      { custom: [{ id: 'custom-1', maxAmount: 40 }] }
    );
    const [fixed] = await applyTrackingModesToPlannedRows(fixedDb, [plannedStandard({
      creditCardId: null,
      predefinedBenefitId: null,
      benefitId: 'custom-1',
    })], NOW);
    expect(fixed.usedAmount).toBe(12.5);

    const zeroDb = database(
      [standardPreference({ mode: 'AUTO_CLAIM' })],
      { predefined: [{ id: 'pb-1', maxAmount: null }] }
    );
    const [zero] = await applyTrackingModesToPlannedRows(zeroDb, [plannedStandard()], NOW);
    expect(zero).toEqual({
      isCompleted: true,
      completedAt: NOW,
      usedAmount: 0,
      claimSource: 'AUTO',
    });
  });

  it('uses fast paths for empty batches and batches with no automatic choice', async () => {
    const emptyDb = database([standardPreference()]);
    expect(await applyTrackingModesToPlannedRows(emptyDb, [])).toEqual([]);
    expect(preferenceDelegate(emptyDb).findMany).not.toHaveBeenCalled();

    const ignoredDb = database([standardPreference({ mode: 'IGNORE' })]);
    await applyTrackingModesToPlannedRows(ignoredDb, [plannedStandard()]);
    expect((ignoredDb as never as { predefinedBenefit: { findMany: jest.Mock } })
      .predefinedBenefit.findMany).not.toHaveBeenCalled();
  });

  it('does not apply one user configuration to another user', async () => {
    const db = database(
      [standardPreference({ userId: 'user-1', mode: 'AUTO_CLAIM', autoClaimAmountCents: 500 })],
      { predefined: [{ id: 'pb-1', maxAmount: 25 }] }
    );
    const [first, second] = await applyTrackingModesToPlannedRows(db, [
      plannedStandard({ userId: 'user-1' }),
      plannedStandard({ userId: 'user-2' }),
    ]);
    expect(first.usedAmount).toBe(5);
    expect(second.isCompleted).toBe(false);
  });
});

describe('claimWindowEntryAutoClaims', () => {
  it('applies each full/fixed preference to virgin open rows only', async () => {
    const db = database(
      [
        standardPreference({ mode: 'AUTO_CLAIM', autoClaimAmountCents: 1500 }),
        standardPreference({
          predefinedBenefitId: 'pb-2',
          mode: 'AUTO_CLAIM',
          autoClaimAmountCents: null,
        }),
      ],
      { predefined: [
        { id: 'pb-1', maxAmount: 25 },
        { id: 'pb-2', maxAmount: 30 },
      ] }
    );

    expect(await claimWindowEntryAutoClaims(db, NOW)).toBe(2);
    const calls = statusUpdateMany(db).mock.calls;
    expect(calls[0][0]).toEqual({
      where: {
        userId: 'user-1',
        creditCardId: 'card-1',
        predefinedBenefitId: 'pb-1',
        cycleStartDate: { lte: NOW },
        cycleEndDate: { gte: NOW },
        isCompleted: false,
        isNotUsable: false,
        usedAmount: 0,
        claimSource: null,
      },
      data: { isCompleted: true, completedAt: NOW, usedAmount: 15, claimSource: 'AUTO' },
    });
    expect(calls[1][0].data.usedAmount).toBe(30);
  });

  it('performs no status write without automatic preferences', async () => {
    const db = database([]);
    expect(await claimWindowEntryAutoClaims(db, NOW)).toBe(0);
    expect(statusUpdateMany(db)).not.toHaveBeenCalled();
  });
});

describe('applyBenefitTrackingConfiguration', () => {
  it('creates a fixed preference and claims every uncompleted open occurrence', async () => {
    const db = database();
    const configuration = {
      mode: 'AUTO_CLAIM',
      value: { kind: 'FIXED', amountCents: 1500 },
    } as const;

    const result = await applyBenefitTrackingConfiguration(db, {
      userId: 'user-1',
      target: standardTarget,
      maximumAmount: 25,
      configuration,
      now: NOW,
    });

    expect(result).toEqual(configuration);
    expect(preferenceDelegate(db).create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        ...standardTarget,
        mode: 'AUTO_CLAIM',
        autoClaimAmountCents: 1500,
      },
    });
    expect(statusUpdateMany(db)).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        creditCardId: 'card-1',
        predefinedBenefitId: 'pb-1',
        cycleStartDate: { lte: NOW },
        cycleEndDate: { gte: NOW },
        isCompleted: false,
      },
      data: {
        isCompleted: true,
        completedAt: NOW,
        usedAmount: 15,
        claimSource: 'AUTO',
        isNotUsable: false,
      },
    });
  });

  it('stores dynamic full as null and supports custom identity', async () => {
    const db = database();
    await applyBenefitTrackingConfiguration(db, {
      userId: 'user-1',
      target: { creditCardId: null, predefinedBenefitId: null, benefitId: 'custom-1' },
      maximumAmount: 40,
      configuration: { mode: 'AUTO_CLAIM', value: { kind: 'FULL' } },
      now: NOW,
    });
    expect(preferenceDelegate(db).create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        benefitId: 'custom-1',
        mode: 'AUTO_CLAIM',
        autoClaimAmountCents: null,
      }),
    });
    expect(statusUpdateMany(db).mock.calls[0][0].where).toEqual(expect.objectContaining({
      userId: 'user-1',
      benefitId: 'custom-1',
    }));
  });

  it('recomputes only AUTO and virgin rows when editing an automatic amount', async () => {
    const existing = standardPreference({ mode: 'AUTO_CLAIM', autoClaimAmountCents: null });
    const db = database([], {}, existing);
    await applyBenefitTrackingConfiguration(db, {
      userId: 'user-1',
      target: standardTarget,
      maximumAmount: 25,
      configuration: {
        mode: 'AUTO_CLAIM',
        value: { kind: 'FIXED', amountCents: 1500 },
      },
      now: NOW,
    });

    expect(preferenceDelegate(db).updateMany).toHaveBeenCalledWith({
      where: { id: 'pref-1', userId: 'user-1' },
      data: { mode: 'AUTO_CLAIM', autoClaimAmountCents: 1500 },
    });
    expect(statusUpdateMany(db).mock.calls[0][0].where.OR).toEqual([
      { claimSource: 'AUTO' },
      { claimSource: null, isCompleted: false, isNotUsable: false, usedAmount: 0 },
    ]);
  });

  it('is idempotent when the normalized configuration is unchanged', async () => {
    const db = database([], {}, standardPreference({
      mode: 'AUTO_CLAIM',
      autoClaimAmountCents: 1500,
    }));
    await applyBenefitTrackingConfiguration(db, {
      userId: 'user-1',
      target: standardTarget,
      maximumAmount: 25,
      configuration: {
        mode: 'AUTO_CLAIM',
        value: { kind: 'FIXED', amountCents: 1500 },
      },
      now: NOW,
    });
    expect(preferenceDelegate(db).updateMany).not.toHaveBeenCalled();
    expect(statusUpdateMany(db)).not.toHaveBeenCalled();
  });

  it('reopens only current AUTO claims when leaving automatic mode', async () => {
    const db = database([], {}, standardPreference({ mode: 'AUTO_CLAIM' }));
    await applyBenefitTrackingConfiguration(db, {
      userId: 'user-1',
      target: standardTarget,
      maximumAmount: 25,
      configuration: { mode: 'TRACK' },
      expectedPreferenceId: 'pref-1',
      now: NOW,
    });

    expect(preferenceDelegate(db).deleteMany).toHaveBeenCalledWith({
      where: { id: 'pref-1', userId: 'user-1' },
    });
    expect(statusUpdateMany(db)).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: 'user-1',
        isCompleted: true,
        claimSource: 'AUTO',
        cycleStartDate: { lte: NOW },
        cycleEndDate: { gte: NOW },
      }),
      data: {
        isCompleted: false,
        completedAt: null,
        usedAmount: 0,
        claimSource: null,
      },
    });
  });

  it('does not attempt a status mutation when preference persistence fails', async () => {
    const db = database();
    preferenceDelegate(db).create.mockRejectedValueOnce(new Error('persistence failed'));

    await expect(applyBenefitTrackingConfiguration(db, {
      userId: 'user-1',
      target: standardTarget,
      maximumAmount: 25,
      configuration: { mode: 'AUTO_CLAIM', value: { kind: 'FULL' } },
      now: NOW,
    })).rejects.toThrow('persistence failed');

    expect(statusUpdateMany(db)).not.toHaveBeenCalled();
  });

  it('rejects invalid fixed values before opening a transaction', async () => {
    const db = database();
    await expect(applyBenefitTrackingConfiguration(db, {
      userId: 'user-1',
      target: standardTarget,
      maximumAmount: 10,
      configuration: {
        mode: 'AUTO_CLAIM',
        value: { kind: 'FIXED', amountCents: 1500 },
      },
    })).rejects.toThrow('cannot exceed $10.00');
    expect((db as never as { $transaction: jest.Mock }).$transaction).not.toHaveBeenCalled();
  });

  it('fails the settings ownership gate when the expected preference is absent', async () => {
    const db = database();
    await expect(applyBenefitTrackingConfiguration(db, {
      userId: 'user-1',
      target: standardTarget,
      maximumAmount: 25,
      configuration: { mode: 'IGNORE' },
      expectedPreferenceId: 'foreign-pref',
    })).rejects.toThrow('not found or permission denied');
    expect(preferenceDelegate(db).create).not.toHaveBeenCalled();
    expect(statusUpdateMany(db)).not.toHaveBeenCalled();
  });

  it('rejects malformed standard/custom target combinations', async () => {
    const db = database();
    await expect(applyBenefitTrackingConfiguration(db, {
      userId: 'user-1',
      target: { creditCardId: null, predefinedBenefitId: 'pb-1', benefitId: null },
      maximumAmount: 25,
      configuration: { mode: 'IGNORE' },
    })).rejects.toThrow('Invalid benefit tracking target');
  });
});
