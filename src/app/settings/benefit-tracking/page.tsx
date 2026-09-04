import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { Metadata } from 'next';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import PageHeader from '@/components/ui/PageHeader';
import { configurationFromPreference } from '@/lib/benefit-tracking-modes';
import BenefitTrackingClient, {
  type TrackedBenefitPreference,
} from './BenefitTrackingClient';

export const metadata: Metadata = {
  title: 'Benefit Tracking - Settings',
  description: 'Review and edit benefits you auto-claim or ignore.',
  alternates: {
    canonical: '/settings/benefit-tracking',
  },
};

/**
 * The management surface for cycle-independent tracking choices, including a
 * second place to review and restore benefits shown in the dashboard's Ignored
 * tab.
 */
export default async function BenefitTrackingSettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect('/api/auth/signin?callbackUrl=/settings/benefit-tracking');
  }

  const preferences = await prisma.benefitTrackingPreference.findMany({
    where: { userId: session.user.id, mode: { not: 'TRACK' } },
    select: {
      id: true,
      mode: true,
      autoClaimAmountCents: true,
      creditCardId: true,
      predefinedBenefitId: true,
      benefitId: true,
      creditCard: { select: { name: true, nickname: true, lastFourDigits: true } },
      predefinedBenefit: {
        select: {
          description: true,
          category: true,
          maxAmount: true,
          frequency: true,
          occurrencesInCycle: true,
          predefinedCard: { select: { name: true } },
        },
      },
      benefit: {
        select: {
          description: true,
          category: true,
          maxAmount: true,
          frequency: true,
          occurrencesInCycle: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const items: TrackedBenefitPreference[] = preferences.map((preference) => {
    const definition = preference.predefinedBenefit ?? preference.benefit;
    const configuration = configurationFromPreference(preference);
    if (configuration.mode === 'TRACK') {
      throw new Error('Unexpected normal-tracking preference in settings query.');
    }
    const card = preference.creditCard;
    const cardLabel = card
      ? [card.nickname || card.name, card.lastFourDigits ? `••${card.lastFourDigits}` : null]
          .filter(Boolean)
          .join(' ')
      : preference.predefinedBenefit?.predefinedCard?.name ?? 'Custom benefit';

    return {
      id: preference.id,
      configuration,
      description: definition?.description ?? 'Unknown benefit',
      category: definition?.category ?? 'Other',
      cardLabel,
      maxAmount: definition?.maxAmount ?? null,
      frequency: definition?.frequency ?? 'ONE_TIME',
      occurrencesInCycle: definition?.occurrencesInCycle ?? 1,
    };
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        title="Benefit Tracking"
        description="Review full or partial automatic claims, ignored benefits, and normal tracking."
      />
      <BenefitTrackingClient preferences={items} />
    </div>
  );
}
