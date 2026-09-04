import type { Session } from 'next-auth';

jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
jest.mock('@/lib/auth', () => ({ authOptions: {} }));
jest.mock('@/lib/effective-benefit', () => ({
  findEffectiveBenefitStatus: jest.fn(),
  fetchEffectiveBenefitStatuses: jest.fn(),
}));
jest.mock('@/lib/benefit-tracking-preferences', () => ({
  applyTrackingModesToPlannedRows: jest.fn(),
  applyBenefitTrackingConfiguration: jest.fn(),
}));

import {
  resetBenefitTrackingPreferenceAction,
  setBenefitTrackingModeAction,
  updateBenefitTrackingPreferenceAction,
} from '../actions';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { revalidatePath } from 'next/cache';
import { findEffectiveBenefitStatus } from '@/lib/effective-benefit';
import { BenefitTrackingConfigurationError } from '@/lib/benefit-tracking-modes';
import { applyBenefitTrackingConfiguration } from '@/lib/benefit-tracking-preferences';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockGetServerSession = jest.mocked(getServerSession);
const mockFindStatus = findEffectiveBenefitStatus as jest.Mock;
const mockApplyConfiguration = applyBenefitTrackingConfiguration as jest.Mock;
const preferenceFindFirst = mockPrisma.benefitTrackingPreference.findFirst as jest.Mock;
const mockRevalidatePath = jest.mocked(revalidatePath);

const SESSION: Session = { user: { id: 'user-1' }, expires: '2030-01-01' };

function standardStatus(overrides: Record<string, unknown> = {}) {
  return {
    id: 'status-1',
    userId: 'user-1',
    benefitId: 'bridge-benefit-1',
    creditCardId: 'card-1',
    predefinedBenefitId: 'pb-1',
    isCompleted: false,
    benefit: { maxAmount: 25, category: 'Travel' },
    ...overrides,
  };
}

function ownedPreference(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pref-1',
    creditCardId: 'card-1',
    predefinedBenefitId: 'pb-1',
    benefitId: null,
    predefinedBenefit: { maxAmount: 25 },
    benefit: null,
    ...overrides,
  };
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetServerSession.mockResolvedValue(SESSION);
  mockFindStatus.mockResolvedValue(standardStatus());
  preferenceFindFirst.mockResolvedValue(ownedPreference());
  mockApplyConfiguration.mockImplementation(async (_database, input) => input.configuration);
});

describe('setBenefitTrackingModeAction', () => {
  it('parses a fixed amount and delegates the owned status target/current maximum', async () => {
    const result = await setBenefitTrackingModeAction(form({
      benefitStatusId: 'status-1',
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FIXED',
      autoClaimAmount: '15.00',
    }));

    expect(result).toEqual({
      success: true,
      configuration: {
        mode: 'AUTO_CLAIM',
        value: { kind: 'FIXED', amountCents: 1500 },
      },
    });
    expect(mockFindStatus).toHaveBeenCalledWith(prisma, 'user-1', 'status-1');
    expect(mockApplyConfiguration).toHaveBeenCalledWith(prisma, expect.objectContaining({
      userId: 'user-1',
      target: {
        creditCardId: 'card-1',
        predefinedBenefitId: 'pb-1',
        benefitId: null,
      },
      maximumAmount: 25,
      configuration: {
        mode: 'AUTO_CLAIM',
        value: { kind: 'FIXED', amountCents: 1500 },
      },
    }));
  });

  it('supports dynamic full and custom-benefit identity', async () => {
    mockFindStatus.mockResolvedValue(standardStatus({
      creditCardId: null,
      predefinedBenefitId: null,
      benefitId: 'custom-1',
      benefit: { maxAmount: 40, category: 'Other' },
    }));

    await setBenefitTrackingModeAction(form({
      benefitStatusId: 'status-1',
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FULL',
    }));

    expect(mockApplyConfiguration).toHaveBeenCalledWith(prisma, expect.objectContaining({
      target: { creditCardId: null, predefinedBenefitId: null, benefitId: 'custom-1' },
      maximumAmount: 40,
      configuration: { mode: 'AUTO_CLAIM', value: { kind: 'FULL' } },
    }));
  });

  it.each(['TRACK', 'IGNORE'] as const)('passes the %s configuration without auto fields', async (mode) => {
    await setBenefitTrackingModeAction(form({
      benefitStatusId: 'status-1',
      trackingMode: mode,
    }));
    expect(mockApplyConfiguration).toHaveBeenCalledWith(prisma, expect.objectContaining({
      configuration: { mode },
    }));
  });

  it('revalidates every surface only after success', async () => {
    await setBenefitTrackingModeAction(form({
      benefitStatusId: 'status-1',
      trackingMode: 'IGNORE',
    }));
    expect(mockRevalidatePath.mock.calls.map(([path]) => path)).toEqual([
      '/benefits',
      '/',
      '/settings/benefit-tracking',
    ]);
  });

  it('rejects malformed semantic input before an ownership read', async () => {
    await expect(setBenefitTrackingModeAction(form({
      benefitStatusId: 'status-1',
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FIXED',
      autoClaimAmount: '15abc',
    }))).resolves.toEqual({
      success: false,
      error: expect.stringContaining('no more than two decimal places'),
    });
    expect(mockFindStatus).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it('rejects contradictory non-auto fields before reading status', async () => {
    await expect(setBenefitTrackingModeAction(form({
      benefitStatusId: 'status-1',
      trackingMode: 'IGNORE',
      autoClaimValueKind: 'FULL',
    }))).resolves.toEqual({
      success: false,
      error: expect.stringContaining('only valid for automatic claiming'),
    });
    expect(mockFindStatus).not.toHaveBeenCalled();
  });

  it('refuses unauthenticated, missing, and foreign status requests', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    await expect(setBenefitTrackingModeAction(form({
      benefitStatusId: 'status-1',
      trackingMode: 'IGNORE',
    }))).resolves.toEqual({ success: false, error: 'User not authenticated.' });
    expect(mockFindStatus).not.toHaveBeenCalled();

    mockGetServerSession.mockResolvedValueOnce(SESSION);
    await expect(setBenefitTrackingModeAction(form({ trackingMode: 'IGNORE' })))
      .resolves.toEqual({ success: false, error: 'Benefit Status ID is missing.' });

    mockFindStatus.mockResolvedValueOnce(null);
    await expect(setBenefitTrackingModeAction(form({
      benefitStatusId: 'foreign-status',
      trackingMode: 'IGNORE',
    }))).resolves.toEqual({
      success: false,
      error: 'Benefit status not found or permission denied.',
    });
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it('preserves stable domain validation and masks unexpected persistence errors', async () => {
    mockApplyConfiguration.mockRejectedValueOnce(
      new BenefitTrackingConfigurationError('Custom tracked value cannot exceed $10.00.')
    );
    await expect(setBenefitTrackingModeAction(form({
      benefitStatusId: 'status-1',
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FIXED',
      autoClaimAmount: '15',
    }))).resolves.toEqual({
      success: false,
      error: 'Custom tracked value cannot exceed $10.00.',
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();

    mockApplyConfiguration.mockRejectedValueOnce(new Error('native database detail'));
    await expect(setBenefitTrackingModeAction(form({
      benefitStatusId: 'status-1',
      trackingMode: 'IGNORE',
    }))).resolves.toEqual({
      success: false,
      error: 'Failed to update benefit tracking mode.',
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe('updateBenefitTrackingPreferenceAction', () => {
  it('loads a preference by id plus owner and delegates an editable fixed choice', async () => {
    await updateBenefitTrackingPreferenceAction(form({
      preferenceId: 'pref-1',
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FIXED',
      autoClaimAmount: '12.50',
    }));

    expect(preferenceFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'pref-1', userId: 'user-1' },
    }));
    expect(mockApplyConfiguration).toHaveBeenCalledWith(prisma, expect.objectContaining({
      userId: 'user-1',
      expectedPreferenceId: 'pref-1',
      maximumAmount: 25,
      configuration: {
        mode: 'AUTO_CLAIM',
        value: { kind: 'FIXED', amountCents: 1250 },
      },
    }));
  });

  it('resolves a custom preference maximum without trusting the browser', async () => {
    preferenceFindFirst.mockResolvedValue(ownedPreference({
      creditCardId: null,
      predefinedBenefitId: null,
      benefitId: 'custom-1',
      predefinedBenefit: null,
      benefit: { maxAmount: 40 },
    }));

    await updateBenefitTrackingPreferenceAction(form({
      preferenceId: 'pref-1',
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FULL',
    }));

    expect(mockApplyConfiguration).toHaveBeenCalledWith(prisma, expect.objectContaining({
      target: { creditCardId: null, predefinedBenefitId: null, benefitId: 'custom-1' },
      maximumAmount: 40,
    }));
  });

  it('returns the same not-found result for a missing or foreign preference', async () => {
    preferenceFindFirst.mockResolvedValue(null);
    await expect(updateBenefitTrackingPreferenceAction(form({
      preferenceId: 'foreign-pref',
      trackingMode: 'IGNORE',
    }))).resolves.toEqual({
      success: false,
      error: 'Tracking preference not found or permission denied.',
    });
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it('rejects invalid input before a preference lookup', async () => {
    await expect(updateBenefitTrackingPreferenceAction(form({
      preferenceId: 'pref-1',
      trackingMode: 'AUTO_CLAIM',
      autoClaimValueKind: 'FIXED',
      autoClaimAmount: '0',
    }))).resolves.toEqual({
      success: false,
      error: expect.stringContaining('at least $0.01'),
    });
    expect(preferenceFindFirst).not.toHaveBeenCalled();
  });
});

describe('resetBenefitTrackingPreferenceAction', () => {
  it('delegates one-click reset through the same TRACK transaction owner', async () => {
    const result = await resetBenefitTrackingPreferenceAction(form({ preferenceId: 'pref-1' }));
    expect(result).toEqual({ success: true, configuration: { mode: 'TRACK' } });
    expect(mockApplyConfiguration).toHaveBeenCalledWith(prisma, expect.objectContaining({
      userId: 'user-1',
      expectedPreferenceId: 'pref-1',
      configuration: { mode: 'TRACK' },
    }));
    expect(mockRevalidatePath.mock.calls.map(([path]) => path)).toEqual([
      '/benefits',
      '/',
      '/settings/benefit-tracking',
    ]);
  });

  it('refuses unauthenticated, missing-id, and foreign resets', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    await expect(resetBenefitTrackingPreferenceAction(form({ preferenceId: 'pref-1' })))
      .resolves.toEqual({ success: false, error: 'User not authenticated.' });

    mockGetServerSession.mockResolvedValueOnce(SESSION);
    await expect(resetBenefitTrackingPreferenceAction(form({})))
      .resolves.toEqual({ success: false, error: 'Preference ID is missing.' });

    preferenceFindFirst.mockResolvedValueOnce(null);
    await expect(resetBenefitTrackingPreferenceAction(form({ preferenceId: 'foreign-pref' })))
      .resolves.toEqual({
        success: false,
        error: 'Tracking preference not found or permission denied.',
      });
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });
});
