'use client';

import { useId, useState, type FormEvent } from 'react';
import {
  formatTrackedCurrency,
  normalizeTrackedMaximumCents,
  parseBenefitTrackingConfigurationInput,
  validateBenefitTrackingConfiguration,
  type AutoClaimValueKind,
  type BenefitTrackingConfiguration,
  type BenefitTrackingMode,
} from '@/lib/benefit-tracking-modes';

interface BenefitTrackingEditorProps {
  initialConfiguration: BenefitTrackingConfiguration;
  maxAmount: number | null | undefined;
  occurrencesInCycle?: number | null;
  isPending?: boolean;
  error?: string | null;
  onSave: (configuration: BenefitTrackingConfiguration) => void;
  onCancel: () => void;
  submitLabel?: string;
}

function initialValueKind(configuration: BenefitTrackingConfiguration): AutoClaimValueKind {
  return configuration.mode === 'AUTO_CLAIM' ? configuration.value.kind : 'FULL';
}

function initialFixedAmount(configuration: BenefitTrackingConfiguration): string {
  return configuration.mode === 'AUTO_CLAIM' && configuration.value.kind === 'FIXED'
    ? (configuration.value.amountCents / 100).toFixed(2)
    : '';
}

export default function BenefitTrackingEditor({
  initialConfiguration,
  maxAmount,
  occurrencesInCycle,
  isPending = false,
  error,
  onSave,
  onCancel,
  submitLabel = 'Save tracking choice',
}: BenefitTrackingEditorProps) {
  const id = useId();
  const [mode, setMode] = useState<BenefitTrackingMode>(initialConfiguration.mode);
  const [valueKind, setValueKind] = useState<AutoClaimValueKind>(
    initialValueKind(initialConfiguration)
  );
  const [fixedAmount, setFixedAmount] = useState(initialFixedAmount(initialConfiguration));
  const [localError, setLocalError] = useState<string | null>(null);
  const maximumCents = normalizeTrackedMaximumCents(maxAmount);
  const hasTrackedDollarValue = maximumCents > 0;
  const cadence = (occurrencesInCycle ?? 1) > 1 ? 'occurrence' : 'cycle';
  const errorMessage = localError ?? error;
  const errorId = `${id}-error`;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const configuration = parseBenefitTrackingConfigurationInput({
        trackingMode: mode,
        autoClaimValueKind: mode === 'AUTO_CLAIM'
          ? hasTrackedDollarValue
            ? valueKind
            : 'FULL'
          : undefined,
        autoClaimAmount: mode === 'AUTO_CLAIM'
          && hasTrackedDollarValue
          && valueKind === 'FIXED'
          ? fixedAmount
          : undefined,
      });
      setLocalError(null);
      onSave(validateBenefitTrackingConfiguration(configuration, maxAmount));
    } catch (submitError) {
      setLocalError(
        submitError instanceof Error ? submitError.message : 'Choose a valid tracking option.'
      );
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <fieldset
        disabled={isPending}
        aria-describedby={errorMessage ? errorId : undefined}
        className="space-y-2"
      >
        <legend className="text-sm font-semibold text-foreground">
          How should this benefit be tracked?
        </legend>

        <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 hover:bg-accent/50">
          <input
            type="radio"
            name={`${id}-tracking-mode`}
            value="TRACK"
            checked={mode === 'TRACK'}
            onChange={() => setMode('TRACK')}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-foreground">Track every cycle</span>
            <span className="block text-xs text-muted-foreground">
              You record what you use, including partial amounts.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 hover:bg-accent/50">
          <input
            type="radio"
            name={`${id}-tracking-mode`}
            value="AUTO_CLAIM"
            checked={mode === 'AUTO_CLAIM'}
            onChange={() => setMode('AUTO_CLAIM')}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-foreground">Claim automatically</span>
            <span className="block text-xs text-muted-foreground">
              Each {cadence} opens as claimed, with the tracked value you choose below.
            </span>
          </span>
        </label>

        {mode === 'AUTO_CLAIM' && (
          <div className="ml-7 rounded-lg bg-muted/50 p-3">
            {hasTrackedDollarValue ? (
              <fieldset disabled={isPending} className="space-y-3">
                <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Value counted toward ROI per {cadence}
                </legend>

                <label className="mt-2 flex cursor-pointer gap-2 text-sm text-foreground">
                  <input
                    type="radio"
                    name={`${id}-auto-value`}
                    value="FULL"
                    checked={valueKind === 'FULL'}
                    onChange={() => setValueKind('FULL')}
                  />
                  <span>
                    Full tracked value — {formatTrackedCurrency(maximumCents)}
                    <span className="block text-xs text-muted-foreground">
                      Follows the benefit&apos;s current value automatically.
                    </span>
                  </span>
                </label>

                <label className="flex cursor-pointer gap-2 text-sm text-foreground">
                  <input
                    type="radio"
                    name={`${id}-auto-value`}
                    value="FIXED"
                    checked={valueKind === 'FIXED'}
                    onChange={() => setValueKind('FIXED')}
                  />
                  <span>
                    A partial amount
                    <span className="block text-xs text-muted-foreground">
                      Count one fixed dollar value each time it is claimed.
                    </span>
                  </span>
                </label>

                {valueKind === 'FIXED' && (
                  <div>
                    <label
                      htmlFor={`${id}-fixed-amount`}
                      className="mb-1 block text-xs font-medium text-foreground"
                    >
                      Tracked value per {cadence}
                    </label>
                    <div className="flex max-w-48 items-center rounded-md border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
                      <span aria-hidden="true" className="text-muted-foreground">$</span>
                      <input
                        id={`${id}-fixed-amount`}
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={fixedAmount}
                        onChange={(event) => setFixedAmount(event.target.value)}
                        aria-invalid={Boolean(errorMessage)}
                        aria-describedby={`${id}-amount-help${errorMessage ? ` ${errorId}` : ''}`}
                        className="min-w-0 flex-1 bg-transparent px-1 py-2 text-sm text-foreground outline-none"
                        placeholder="0.00"
                      />
                    </div>
                    <p id={`${id}-amount-help`} className="mt-1 text-xs text-muted-foreground">
                      Enter $0.01–{formatTrackedCurrency(maximumCents)}. This closes the {cadence}
                      but counts only this amount toward ROI.
                    </p>
                  </div>
                )}
              </fieldset>
            ) : (
              <p className="text-xs text-muted-foreground">
                This benefit has no tracked dollar value. It will be marked claimed automatically
                and contribute $0.00 toward ROI.
              </p>
            )}
          </div>
        )}

        <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 hover:bg-accent/50">
          <input
            type="radio"
            name={`${id}-tracking-mode`}
            value="IGNORE"
            checked={mode === 'IGNORE'}
            onChange={() => setMode('IGNORE')}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-foreground">Ignore this benefit</span>
            <span className="block text-xs text-muted-foreground">
              Move it to the Ignored tab and exclude it from claimed value and ROI.
            </span>
          </span>
        </label>
      </fieldset>

      {errorMessage && (
        <p id={errorId} role="alert" className="rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
          {errorMessage}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="min-h-10 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="min-h-10 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
