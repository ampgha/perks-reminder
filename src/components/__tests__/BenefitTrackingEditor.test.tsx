import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import BenefitTrackingEditor from '../BenefitTrackingEditor';

describe('BenefitTrackingEditor', () => {
  it('offers semantic tracking choices and defaults auto-claim to the full value', () => {
    const onSave = jest.fn();
    render(
      <BenefitTrackingEditor
        initialConfiguration={{ mode: 'TRACK' }}
        maxAmount={25}
        onSave={onSave}
        onCancel={jest.fn()}
      />
    );

    expect(screen.getByRole('radio', { name: /Track every cycle/i })).toBeChecked();
    const automaticChoice = screen.getByRole('radio', { name: /Claim automatically/i });
    automaticChoice.focus();
    expect(automaticChoice).toHaveFocus();
    fireEvent.click(automaticChoice);
    expect(screen.getByRole('radio', { name: /Full tracked value — \$25\.00/i })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /Save tracking choice/i }));
    expect(onSave).toHaveBeenCalledWith({
      mode: 'AUTO_CLAIM',
      value: { kind: 'FULL' },
    });
  });

  it('submits a fixed partial amount per occurrence', () => {
    const onSave = jest.fn();
    render(
      <BenefitTrackingEditor
        initialConfiguration={{ mode: 'TRACK' }}
        maxAmount={25}
        occurrencesInCycle={12}
        onSave={onSave}
        onCancel={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('radio', { name: /Claim automatically/i }));
    fireEvent.click(screen.getByRole('radio', { name: /Custom tracked value/i }));
    fireEvent.change(screen.getByLabelText(/Tracked value per occurrence/i), {
      target: { value: '15' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save tracking choice/i }));

    expect(onSave).toHaveBeenCalledWith({
      mode: 'AUTO_CLAIM',
      value: { kind: 'FIXED', amountCents: 1500 },
    });
    expect(screen.getByText(/closes the occurrence/i)).toBeInTheDocument();
  });

  it('prefills an existing fixed amount and validates it against the maximum', () => {
    const onSave = jest.fn();
    render(
      <BenefitTrackingEditor
        initialConfiguration={{
          mode: 'AUTO_CLAIM',
          value: { kind: 'FIXED', amountCents: 1500 },
        }}
        maxAmount={25}
        onSave={onSave}
        onCancel={jest.fn()}
      />
    );

    const input = screen.getByLabelText(/Tracked value per cycle/i);
    expect(input).toHaveValue('15.00');
    fireEvent.change(input, { target: { value: '30' } });

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('cannot exceed $25.00');
    expect(input).toHaveValue('30');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.parentElement).toHaveClass('border-destructive');
    expect(screen.getByRole('button', { name: /Save tracking choice/i })).toBeDisabled();
    expect(input.getAttribute('aria-describedby')).toContain(
      screen.getByRole('alert').id
    );

    fireEvent.change(input, { target: { value: '20' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(input.parentElement).toHaveClass('border-input');
    expect(screen.getByRole('button', { name: /Save tracking choice/i })).toBeEnabled();
  });

  it('immediately flags fixed values below one cent', () => {
    render(
      <BenefitTrackingEditor
        initialConfiguration={{ mode: 'TRACK' }}
        maxAmount={25}
        onSave={jest.fn()}
        onCancel={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('radio', { name: /Claim automatically/i }));
    fireEvent.click(screen.getByRole('radio', { name: /Custom tracked value/i }));
    const input = screen.getByLabelText(/Tracked value per cycle/i);
    fireEvent.change(input, { target: { value: '0' } });

    expect(screen.getByRole('alert')).toHaveTextContent('must be at least $0.01');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: /Save tracking choice/i })).toBeDisabled();
    expect(screen.getByText(/This closes the cycle but counts only this amount toward ROI\./))
      .toBeInTheDocument();
  });

  it('uses binary claimed status with zero ROI for non-dollar benefits', () => {
    const onSave = jest.fn();
    render(
      <BenefitTrackingEditor
        initialConfiguration={{ mode: 'TRACK' }}
        maxAmount={0}
        onSave={onSave}
        onCancel={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('radio', { name: /Claim automatically/i }));
    expect(screen.queryByRole('radio', { name: /Custom tracked value/i })).not.toBeInTheDocument();
    expect(screen.getByText(/contribute \$0\.00 toward ROI/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save tracking choice/i }));

    expect(onSave).toHaveBeenCalledWith({
      mode: 'AUTO_CLAIM',
      value: { kind: 'FULL' },
    });
  });

  it('cancels without submitting', () => {
    const onSave = jest.fn();
    const onCancel = jest.fn();
    render(
      <BenefitTrackingEditor
        initialConfiguration={{ mode: 'IGNORE' }}
        maxAmount={10}
        onSave={onSave}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('disables controls while pending', () => {
    render(
      <BenefitTrackingEditor
        initialConfiguration={{ mode: 'IGNORE' }}
        maxAmount={10}
        isPending
        onSave={jest.fn()}
        onCancel={jest.fn()}
      />
    );

    expect(screen.getByRole('radio', { name: /Ignore this benefit/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  });
});
