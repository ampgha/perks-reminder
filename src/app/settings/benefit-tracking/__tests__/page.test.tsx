import { render, screen } from '@testing-library/react';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import BenefitTrackingSettingsPage from '../page';

jest.mock('next-auth', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/auth', () => ({ authOptions: {} }));
jest.mock('next/navigation', () => ({ redirect: jest.fn() }));
jest.mock('../BenefitTrackingClient', () => ({
  __esModule: true,
  default: ({ preferences }: { preferences: Array<{ cardLabel: string }> }) => (
    <div>{preferences.map((preference) => preference.cardLabel).join(',')}</div>
  ),
}));

const mockedSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const preferenceFindMany = prisma.benefitTrackingPreference.findMany as jest.Mock;

describe('BenefitTrackingSettingsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSession.mockResolvedValue({ user: { id: 'user-1' }, expires: '2030-01-01' });
  });

  it('shows physical-card identity for a card-linked custom benefit', async () => {
    preferenceFindMany.mockResolvedValue([{
      id: 'preference-1',
      mode: 'IGNORE',
      autoClaimAmountCents: null,
      creditCardId: null,
      predefinedBenefitId: null,
      benefitId: 'benefit-1',
      creditCard: null,
      predefinedBenefit: null,
      benefit: {
        description: 'Custom dining credit',
        category: 'Dining',
        maxAmount: 25,
        frequency: 'MONTHLY',
        occurrencesInCycle: 1,
        creditCard: {
          name: 'Physical Card',
          nickname: 'Dining Card',
          lastFourDigits: '1234',
        },
      },
    }]);

    render(await BenefitTrackingSettingsPage());

    expect(screen.getByText('Dining Card ••1234')).toBeInTheDocument();
    expect(preferenceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        benefit: {
          select: expect.objectContaining({
            creditCard: { select: { name: true, nickname: true, lastFourDigits: true } },
          }),
        },
      }),
    }));
  });
});
