# Benefit Tracking Modes

A Benefit Tracking Mode is a user-owned, cycle-independent choice about how one
benefit should behave in every future Benefit Cycle. Completion and claimed
dollar value are separate facts: an occurrence can be closed automatically
while contributing only part of the benefit's maximum—or `$0`—to claimed value
and ROI.

| Mode | Stored? | New occurrences | Dashboard | Claimed value / ROI |
| --- | --- | --- | --- | --- |
| `TRACK` | No row | Open | Visible | What the user records |
| `AUTO_CLAIM` + full | Row, amount `NULL` | Claimed | Visible, in Claimed | Current full tracked value |
| `AUTO_CLAIM` + fixed | Row, positive cents | Claimed | Visible, in Claimed | Fixed value, capped at the current maximum |
| `IGNORE` | Row, amount `NULL` | Open | Visible in the read-only Ignored tab | Excluded |

`TRACK` is the default and is represented by the absence of a preference row.
Existing `AUTO_CLAIM` rows have a null amount and therefore retain the full-value
behavior introduced in PR #22.

## Full and fixed automatic values

For a benefit with a positive `maxAmount`, a user can choose:

- **Full value:** the occurrence uses the benefit's current maximum. This is
  dynamic, so a later catalog-value change automatically affects future
  materialization and eligible open occurrences.
- **A partial amount:** the occurrence uses one fixed USD value stored as
  integer cents. It must be at least `$0.01` and no more than the authoritative
  current maximum when saved.

The fixed amount applies **per occurrence**, not per outer cycle. A benefit with
12 occurrences and a `$15` fixed value can therefore contribute `$15` for each
claimed occurrence. Both variants mark the occurrence complete, so it leaves
Upcoming and no longer generates ordinary reminder attention.

If a definition's maximum later falls below a saved fixed value, the saved
preference is not silently rewritten. Runtime resolution caps the effective
amount at the new maximum and settings displays a warning until the user edits
the preference. If the maximum becomes zero, the effective amount is zero.

## Non-dollar and estimated-value benefits

The model tracks claimed dollar value for ROI; it does not model quantities such
as lounge visits, certificates, nights, or guests. A benefit with no positive
`maxAmount` therefore offers binary automatic claimed status only. It closes
automatically and contributes `$0.00` toward ROI; a fixed dollar input is not
shown.

For non-cash benefits that do have a positive estimated `maxAmount`, the same
full/fixed choice is available, but the UI calls it a **tracked value** and
states that it is the amount counted toward ROI. It is not a claim that the
underlying perk is literally cash. Quantity tracking is outside this contract.

## Identity

Preferences use the same identity as `BenefitStatus`:

- Standard benefits: `(userId, creditCardId, predefinedBenefitId)`
- Custom benefits: `(userId, benefitId)`

The Physical Card ID is part of standard identity, so two copies of the same
card product can be configured independently.

## Claim provenance

`BenefitStatus.claimSource` records who last set a row's claim state:

| Value | Meaning |
| --- | --- |
| `NULL` | Untouched since materialization, including rows predating provenance |
| `AUTO` | Claimed by this feature during a mode change, materialization, or window entry |
| `USER` | A manual action, batch action, partial edit, or applied AMEX Sync Confirmation |

Every manual mutation stamps `USER`. Automatic configuration edits and resets
may rewrite or reopen only `AUTO` rows plus completely virgin null-source rows
where the transition explicitly allows it. A user-edited occurrence is never
silently reclaimed or reopened.

The dashboard retains one narrow compatibility rule: a completed row with
`usedAmount = 0` and `claimSource = NULL` is treated as having its legacy full
value. An explicit `AUTO` or `USER` zero is real and contributes zero.

## Effect on the current cycle

A preference addresses the benefit, so every matching occurrence in the
currently open cycle is considered together. All writes include authenticated
user identity, exact standard/custom benefit identity, and
`cycleStartDate <= now <= cycleEndDate`; closed history and future scheduled
cycles cannot be changed.

| Transition | Eligible open occurrences |
| --- | --- |
| Non-auto → auto | Complete all uncompleted rows at the resolved value, stamp `AUTO`, and clear `isNotUsable` |
| Auto full ↔ fixed, or fixed amount edit | Recompute `AUTO` rows and virgin untouched rows; preserve `USER` rows |
| Auto → track/ignore | Reopen completed `AUTO` rows and clear their automatic value; preserve `USER` rows |
| Track ↔ ignore | Do not alter status state or value |
| Any configuration → same configuration | Idempotent; do not rewrite the preference or statuses |
| Any → track | Delete the preference row, restoring absence-means-default |

Entering auto intentionally overrides an uncompleted manual partial row in the
open cycle: choosing auto is an explicit instruction to close that benefit now.
After auto is active, any subsequent manual edit stamps `USER` and is protected
from later automatic configuration changes.

## Historical ROI and ignored benefits

No preference mutation rewrites a closed cycle. Turning on automatic claiming
does not backfill earlier unclaimed cycles, and turning it off leaves closed
automatic claims intact. Claimed totals and card-level ROI use the actual
`BenefitStatus.usedAmount`, so a completed `$15 of $25` occurrence contributes
`$15`, not `$25`.

`IGNORE` is a read filter rather than a delete. While set, it removes all of the
benefit's statuses from tracked dashboard tabs, reminders, claimed totals, and
ROI, while keeping them visible in the read-only Ignored tab. Resetting to
normal tracking restores the unchanged rows and their values.

## Shared ownership and application paths

Pure configuration parsing, validation, amount resolution, summaries, and
initial status fields live in `src/lib/benefit-tracking-modes.ts`. Database-aware
loading, filtering, materialization, window entry, and preference/status
transactions live in `src/lib/benefit-tracking-preferences.ts`. UI and route
callers must not reimplement the full/fixed/capping calculation.

Preference-aware reads cover the benefits and home dashboards, card calendar,
benefits/card APIs, and notification digest. Integrity, repair, catalog-sync,
and audit readers deliberately remain unfiltered so a display preference cannot
hide consistency evidence.

All status-creation paths apply the shared resolver:

- recurring-cycle materialization in `check-benefits`;
- adding a Physical Card;
- custom-benefit creation through both the server action and API;
- scheduled-window entry, which claims only virgin rows after their window opens.

## User surfaces

The benefit-card tracking control displays the current configuration summary,
such as `Auto: full ($25.00)`, `Auto: $15.00/occurrence`, `Auto: claimed`, or
`Ignored`. Its shared editor requires an explicit Save and offers normal,
automatic, and ignored modes plus full/fixed value when meaningful. Completed
partial automatic claims display as `$15.00 of $25.00` while retaining the
`Claimed` status.

`/settings/benefit-tracking` lists every non-default preference, including the
ignored benefits also available from the dashboard's Ignored tab. It shows card
identity, cadence, full/fixed/zero/ignored detail, current effective value and
any cap warning. Users can edit the full configuration or use the one-click
`Track normally` reset.

## Persistence and deployment sequence

`BenefitTrackingPreference.autoClaimAmountCents` is nullable integer cents. A
named database constraint permits a positive value only for `AUTO_CLAIM` and
requires it to be null for all other modes. The migration is additive and does
not backfill preferences or statuses.

Migration deployment must precede schema-dependent application deployment:

1. Apply and verify all pending migrations, including
   `20260827000000_add_benefit_tracking_preferences` and
   `20260831000000_add_partial_auto_claim_amount`, against the explicitly
   verified target.
2. Deploy the application only after migration status is clean.
3. Smoke-test full, fixed, zero-value, edit, reset, and ignored recovery with a
   disposable authorized test account.

The tracking control is available on scheduled cards too. The preference is
stored immediately; the open-cycle window keeps future status rows untouched
until their cycle opens, at which point window-entry claiming applies.

Deploying this application version before the amount-column migration would
break authenticated preference reads because the new client selects the column
unconditionally.

The dashboard's Ignored tab is read-only except for the tracking control, so an
ignored benefit can be restored without deleting its history.
