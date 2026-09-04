'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { BenefitFrequency } from '@/generated/prisma';
import {
  resetBenefitTrackingPreferenceAction,
  updateBenefitTrackingPreferenceAction,
} from '@/app/benefits/actions';
import BenefitTrackingEditor from '@/components/BenefitTrackingEditor';
import {
  benefitTrackingConfigurationFormFields,
  formatTrackedCurrency,
  resolveAutoClaimValue,
  summarizeBenefitTrackingConfiguration,
  type BenefitTrackingConfiguration,
} from '@/lib/benefit-tracking-modes';

export interface TrackedBenefitPreference {
  id: string;
  configuration: Exclude<BenefitTrackingConfiguration, { mode: 'TRACK' }>;
  description: string;
  category: string;
  cardLabel: string;
  maxAmount: number | null;
  frequency: BenefitFrequency;
  occurrencesInCycle: number;
}

const FREQUENCY_LABELS: Record<BenefitFrequency, string> = {
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  YEARLY: 'Yearly',
  ONE_TIME: 'One time',
};

function trackingDetail(preference: TrackedBenefitPreference): string {
  const configuration = preference.configuration;
  if (configuration.mode === 'IGNORE') {
    return 'Shown only in the Ignored tab and excluded from claimed value and ROI.';
  }

  const cadence = preference.occurrencesInCycle > 1 ? 'occurrence' : 'cycle';
  const resolved = resolveAutoClaimValue(configuration, preference.maxAmount);
  if (!resolved.hasTrackedDollarValue) {
    return `Each ${cadence} is marked claimed automatically and contributes $0.00 toward ROI.`;
  }
  if (configuration.value.kind === 'FULL') {
    return `Each ${cadence} is claimed automatically at the benefit's current full value (${formatTrackedCurrency(resolved.effectiveAmountCents)}).`;
  }
  return `Each ${cadence} is claimed automatically with ${formatTrackedCurrency(configuration.value.amountCents)} counted toward ROI.`;
}

export default function BenefitTrackingClient({
  preferences,
}: {
  preferences: TrackedBenefitPreference[];
}) {
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSave = (
    preference: TrackedBenefitPreference,
    configuration: BenefitTrackingConfiguration
  ) => {
    const formData = new FormData();
    formData.append('preferenceId', preference.id);
    for (const [name, value] of Object.entries(
      benefitTrackingConfigurationFormFields(configuration)
    )) {
      formData.append(name, value);
    }
    setPendingId(preference.id);

    startTransition(async () => {
      try {
        setError(null);
        await updateBenefitTrackingPreferenceAction(formData);
        setEditingId(null);
      } catch (updateError) {
        console.error('Failed to update tracking preference:', updateError);
        setError(
          updateError instanceof Error
            ? updateError.message
            : 'Failed to update tracking preference.'
        );
      } finally {
        setPendingId(null);
      }
    });
  };

  const handleReset = (preferenceId: string) => {
    const formData = new FormData();
    formData.append('preferenceId', preferenceId);
    setPendingId(preferenceId);

    startTransition(async () => {
      try {
        setError(null);
        await resetBenefitTrackingPreferenceAction(formData);
        setEditingId(null);
      } catch (resetError) {
        console.error('Failed to reset tracking preference:', resetError);
        setError(
          resetError instanceof Error ? resetError.message : 'Failed to reset tracking preference.'
        );
      } finally {
        setPendingId(null);
      }
    });
  };

  if (preferences.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Every benefit is tracked normally. Use the tracking menu on any benefit to claim it
          automatically or ignore it.
        </p>
        <Link
          href="/benefits"
          className="mt-4 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
        >
          Go to benefits
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && editingId === null && (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </p>
      )}

      {preferences.map((preference) => {
        const isEditing = editingId === preference.id;
        const pendingThisPreference = isPending && pendingId === preference.id;
        const summary = summarizeBenefitTrackingConfiguration({
          configuration: preference.configuration,
          maxAmount: preference.maxAmount,
          occurrencesInCycle: preference.occurrencesInCycle,
        });
        const resolved = preference.configuration.mode === 'AUTO_CLAIM'
          ? resolveAutoClaimValue(preference.configuration, preference.maxAmount)
          : null;

        return (
          <div
            key={preference.id}
            className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">
                    {preference.description}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      preference.configuration.mode === 'AUTO_CLAIM'
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {summary}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {preference.cardLabel} · {preference.category} · {FREQUENCY_LABELS[preference.frequency]}
                </p>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {trackingDetail(preference)}
                </p>
                {resolved?.wasCapped && (
                  <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                    The saved value is currently capped at {formatTrackedCurrency(resolved.effectiveAmountCents)}
                    because the benefit&apos;s maximum is lower. Edit this preference to resolve it.
                  </p>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setEditingId(isEditing ? null : preference.id);
                  }}
                  disabled={isPending}
                  aria-expanded={isEditing}
                  className="min-h-10 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  {isEditing ? 'Close editor' : 'Edit'}
                </button>
                <button
                  type="button"
                  onClick={() => handleReset(preference.id)}
                  disabled={isPending}
                  className="min-h-10 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  {pendingThisPreference && !isEditing ? 'Resetting…' : 'Track normally'}
                </button>
              </div>
            </div>

            {isEditing && (
              <div className="mt-4 border-t border-border pt-4">
                <BenefitTrackingEditor
                  initialConfiguration={preference.configuration}
                  maxAmount={preference.maxAmount}
                  occurrencesInCycle={preference.occurrencesInCycle}
                  isPending={pendingThisPreference}
                  error={error}
                  onSave={(configuration) => handleSave(preference, configuration)}
                  onCancel={() => {
                    setError(null);
                    setEditingId(null);
                  }}
                  submitLabel="Save preference"
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
