import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  resetBenefitTrackingPreferenceAction,
  updateBenefitTrackingPreferenceAction,
} from '@/app/benefits/actions';
import BenefitTrackingClient, { type TrackedBenefitPreference } from '../BenefitTrackingClient';

jest.mock('@/app/benefits/actions', () => ({
  resetBenefitTrackingPreferenceAction: jest.fn().mockResolvedValue({ success: true }),
  updateBenefitTrackingPreferenceAction: jest.fn().mockResolvedValue({ success: true }),
}));

const fixedPreference: TrackedBenefitPreference = {
  id: 'preference-1',
  configuration: {
    mode: 'AUTO_CLAIM',
    value: { kind: 'FIXED', amountCents: 1500 },
  },
  description: '$25 monthly dining credit',
  category: 'Dining',
  cardLabel: 'Test Card ••1234',
  maxAmount: 25,
  frequency: 'MONTHLY',
  occurrencesInCycle: 12,
};

describe('BenefitTrackingClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows whether automatic claiming uses a full or partial amount', () => {
    render(
      <BenefitTrackingClient
        preferences={[
          fixedPreference,
          {
            ...fixedPreference,
            id: 'preference-2',
            description: 'Annual travel credit',
            frequency: 'YEARLY',
            occurrencesInCycle: 1,
            configuration: { mode: 'AUTO_CLAIM', value: { kind: 'FULL' } },
          },
        ]}
      />
    );

    expect(screen.getByText('Auto: $15.00/occurrence')).toBeInTheDocument();
    expect(screen.getByText('Auto: full ($25.00)')).toBeInTheDocument();
    expect(screen.getByText(/\$15\.00 counted toward ROI/i)).toBeInTheDocument();
  });

  it('edits a fixed amount through the shared editor', async () => {
    const action = updateBenefitTrackingPreferenceAction as jest.MockedFunction<
      typeof updateBenefitTrackingPreferenceAction
    >;
    render(<BenefitTrackingClient preferences={[fixedPreference]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const amount = screen.getByLabelText(/Tracked value per occurrence/i);
    expect(amount).toHaveValue('15.00');
    fireEvent.change(amount, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /Save preference/i }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const submitted = action.mock.calls[0][0];
    expect(submitted.get('preferenceId')).toBe('preference-1');
    expect(submitted.get('trackingMode')).toBe('AUTO_CLAIM');
    expect(submitted.get('autoClaimValueKind')).toBe('FIXED');
    expect(submitted.get('autoClaimAmount')).toBe('10.00');
  });

  it('can return a preference to normal tracking', async () => {
    const action = resetBenefitTrackingPreferenceAction as jest.MockedFunction<
      typeof resetBenefitTrackingPreferenceAction
    >;
    render(<BenefitTrackingClient preferences={[fixedPreference]} />);

    fireEvent.click(screen.getByRole('button', { name: /Track normally/i }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][0].get('preferenceId')).toBe('preference-1');
  });

  it('explains zero-value automatic claiming without offering a dollar amount', () => {
    render(
      <BenefitTrackingClient
        preferences={[{
          ...fixedPreference,
          maxAmount: 0,
          occurrencesInCycle: 1,
          configuration: { mode: 'AUTO_CLAIM', value: { kind: 'FULL' } },
        }]}
      />
    );

    expect(screen.getByText('Auto: claimed')).toBeInTheDocument();
    expect(screen.getByText(/contributes \$0\.00 toward ROI/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('radio', { name: /A partial amount/i })).not.toBeInTheDocument();
  });

  it('warns when a saved fixed value is capped by a reduced benefit maximum', () => {
    render(
      <BenefitTrackingClient
        preferences={[{ ...fixedPreference, maxAmount: 10 }]}
      />
    );

    expect(screen.getByText(/currently capped at \$10\.00/i)).toBeInTheDocument();
  });

  it('keeps an entered amount visible when the server rejects the save', async () => {
    const action = updateBenefitTrackingPreferenceAction as jest.MockedFunction<
      typeof updateBenefitTrackingPreferenceAction
    >;
    action.mockRejectedValueOnce(new Error('The benefit value changed. Try again.'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<BenefitTrackingClient preferences={[fixedPreference]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const amount = screen.getByLabelText(/Tracked value per occurrence/i);
    fireEvent.change(amount, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /Save preference/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The benefit value changed. Try again.'
    );
    expect(amount).toHaveValue('10');
    expect(screen.getByRole('button', { name: /Save preference/i })).toBeEnabled();
    consoleError.mockRestore();
  });

  it('can edit an ignored benefit that is absent from the dashboard', () => {
    render(
      <BenefitTrackingClient
        preferences={[{
          ...fixedPreference,
          configuration: { mode: 'IGNORE' },
        }]}
      />
    );

    expect(screen.getByText('Ignored')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('radio', { name: /Ignore this benefit/i })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /Claim automatically/i }));
    expect(screen.getByRole('radio', { name: /Full tracked value/i })).toBeInTheDocument();
  });
});
