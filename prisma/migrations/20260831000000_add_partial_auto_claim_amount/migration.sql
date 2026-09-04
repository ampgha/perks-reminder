-- Add a fixed USD value option within AUTO_CLAIM. NULL intentionally keeps
-- every existing AUTO_CLAIM preference on dynamic full-value behavior.
ALTER TABLE "BenefitTrackingPreference"
  ADD COLUMN "autoClaimAmountCents" INTEGER;

ALTER TABLE "BenefitTrackingPreference"
  ADD CONSTRAINT "BenefitTrackingPreference_auto_claim_amount_check"
  CHECK (
    (
      "mode" = 'AUTO_CLAIM'
      AND (
        "autoClaimAmountCents" IS NULL
        OR "autoClaimAmountCents" > 0
      )
    )
    OR (
      "mode" <> 'AUTO_CLAIM'
      AND "autoClaimAmountCents" IS NULL
    )
  );
