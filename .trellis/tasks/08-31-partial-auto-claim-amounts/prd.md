# Partial auto-claim amounts

## Goal

Let a user automatically close each Benefit Cycle while counting either the
benefit's full tracked dollar value or a smaller fixed dollar value toward
claimed value and ROI. This removes repetitive confirmation without overstating
what the user actually receives.

## Background

PR #22 introduced cycle-independent `TRACK`, `AUTO_CLAIM`, and `IGNORE` modes.
`AUTO_CLAIM` currently completes each open/new occurrence at `maxAmount`, or at
zero when the definition has no positive tracked dollar value. The application
uses `isCompleted` to decide whether a cycle needs attention and `usedAmount` as
dollar-valued claimed value in dashboard and ROI calculations.

The catalog contains both zero-value non-cash entitlements and non-cash
entitlements assigned estimated dollar values. It has no durable unit field,
and the legacy `percentage` field is zero across the current catalog. Counts,
points, nights, passes, and percentages therefore cannot safely be stored in
`usedAmount`.

## Requirements

### 1. Auto-claim configuration

1. Keep the existing top-level modes `TRACK`, `AUTO_CLAIM`, and `IGNORE`; full
   versus fixed value is configuration within `AUTO_CLAIM`, not another mode.
2. Full-value auto-claim dynamically uses the current positive `maxAmount` for
   each occurrence. Existing `AUTO_CLAIM` preferences retain this behavior.
3. Fixed-value auto-claim stores an exact positive dollar amount in cents and
   applies that value to each occurrence.
4. A new fixed value must be at least `$0.01`, have at most cent precision, and
   not exceed the current effective positive `maxAmount`.
5. If a later catalog or custom-definition edit lowers `maxAmount`, subsequent
   automatic application must cap the effective fixed value at the new maximum
   rather than overstate ROI. Catalog synchronization itself must not rewrite
   any existing status. The saved choice remains visible with an actionable
   warning. If the maximum later increases, the fixed choice remains fixed
   while full-value auto-claim follows the new maximum.
6. `TRACK` remains represented by the absence of a preference row.

### 2. Cycle and provenance behavior

1. Both full and fixed auto-claim mark the occurrence completed, set
   `completedAt`, stamp `claimSource: AUTO`, clear `isNotUsable`, and write the
   resolved dollar value to `usedAmount`.
2. A fixed value below `maxAmount` still closes the cycle. Recording progress
   while preserving reminders remains ordinary `TRACK` behavior and is not an
   auto-claim option.
3. Entering `AUTO_CLAIM` from another mode applies to every uncompleted
   occurrence in the currently open cycle, matching PR #22's existing explicit
   mode-transition behavior. Already completed `USER` rows remain untouched.
4. Editing full/fixed configuration while already in `AUTO_CLAIM` updates only
   currently open occurrences still stamped `AUTO`; a manually overridden
   `USER` occurrence remains untouched.
5. Leaving `AUTO_CLAIM` or resetting the preference reopens only currently open
   `AUTO` occurrences. It never changes a `USER` occurrence.
6. Closed historical cycles and future scheduled cycles are immutable. Future
   materialization and scheduled-window entry use the configuration then in
   effect.
7. For definitions with multiple occurrences, the configured value applies to
   every occurrence, consistent with current full-value auto-claim. UI copy
   must say `per occurrence` for those definitions.
8. `IGNORE` remains a reversible read filter. Integrity and repair tooling must
   continue reading underlying statuses without user-facing filtering.

### 3. Non-dollar and zero-value benefits

1. A definition without a positive tracked dollar value offers only
   `Mark as claimed automatically`; it must not show a partial-dollar input.
2. This binary form completes each occurrence with `usedAmount: 0`, removes it
   from attention/reminder flows, and contributes `$0` to ROI.
3. When a non-cash entitlement already has a positive estimated dollar value,
   full/fixed UI must describe the number as the value counted toward claimed
   value and ROI, not as points, passes, nights, or quantity consumed.
4. No amount/unit behavior may be inferred from benefit description text.

### 4. Benefit-card interaction

1. Preserve the three top-level tracking choices. Selecting `AUTO_CLAIM`
   reveals an accessible nested choice:
   - `Full tracked value — $X each cycle` (or `per occurrence`), which follows
     later definition-value changes;
   - `Custom tracked value`, which reveals a dollar input and explains that the
     amount counts toward claimed value and ROI.
2. The custom input should use the current maximum as a hint, not silently save
   a pre-populated fixed copy. The user must intentionally enter a fixed value.
3. Apply configuration only through an explicit Save action; provide Cancel,
   pending state, and visible server validation errors.
4. The collapsed control must identify the effective configuration, such as
   `Auto: full ($25)`, `Auto: $15/cycle`, `Auto: claimed`, `Ignored`, or
   `Tracking`.
5. A completed occurrence whose `usedAmount` is below `maxAmount` must display
   `$15 of $25` rather than misleadingly displaying the full `$25`.

### 5. Settings interaction

1. `/settings/benefit-tracking` must show full, fixed, capped/stale, zero-value,
   and ignored summaries with card identity and Benefit Cycle cadence.
2. Every non-default preference must be editable from settings because an
   ignored benefit cannot be reached from the dashboard.
3. The settings editor must allow switching among normal tracking,
   full/fixed auto-claim, and ignore, while retaining the existing one-click
   return to normal tracking.
4. Card and settings surfaces must share the client-safe configuration type,
   labels, amount formatting, validation copy, and editor component where their
   interaction requirements are the same.

### 6. Persistence and boundaries

1. Add a nullable exact-cent field to `BenefitTrackingPreference`. Null under
   `AUTO_CLAIM` means dynamic full value; positive cents means fixed value.
2. The migration must be additive and leave existing preferences unchanged.
   Add a database constraint requiring positive non-null cents and null cents
   outside `AUTO_CLAIM`.
3. One pure domain owner must parse persistence, resolve/cap full or fixed
   value, derive status defaults, and produce client-safe configuration
   summaries.
4. The database-aware preference owner must carry the complete configuration
   through single-user/multi-user maps, materialization, and window-entry
   claiming. Consumers must not reimplement amount rules.
5. Card mutations remain status-ID/owned-effective-status based. Settings
   mutations remain preference-ID and authenticated-owner based. Both must use
   the same domain transition and transaction behavior.
6. Validate untrusted form data before writes, reload authoritative ownership
   and current value, use user-scoped writes, and revalidate `/benefits`, `/`,
   and `/settings/benefit-tracking` after successful mutations as applicable.
7. Because authenticated request paths query the preference table
   unconditionally, the checked-in additive migration must be deployed and
   verified before schema-dependent application code reaches auto-deploying
   `main`.

### 7. Documentation

Update `docs/benefit-tracking-modes.md` to distinguish completion from claimed
dollar value; document full/fixed, non-dollar, multiple-occurrence, catalog
change, manual override, current/history, reset, and deployment behavior.

## Acceptance Criteria

1. A user can choose full-value auto-claim for a `$25` benefit; the open cycle
   and each later occurrence close at `$25`, and the card/settings summaries
   identify dynamic full value.
2. A user can choose `$15` fixed auto-claim for that benefit; the open cycle and
   each later occurrence close at `$15`, Upcoming/reminders omit it, and totals
   and ROI add `$15`, not `$25`.
3. Normal partial tracking still records progress and preserves reminders; the
   auto-claim editor offers no `keep remainder open` toggle.
4. Invalid, non-finite, sub-cent, zero, negative, or above-current-maximum fixed
   values produce a stable validation error and no preference/status write.
5. A zero-value free-night/points/pass benefit offers binary auto-claim without
   a dollar input, closes at zero, and adds no invented value to ROI.
6. A positive estimated-value non-cash benefit describes custom input as
   tracked/ROI value and never claims to track its underlying quantity.
7. Lowering a definition maximum below a saved fixed value caps subsequent
   materialization, window-entry claiming, or an explicitly saved open-cycle
   configuration update and presents the saved/effective mismatch for editing;
   catalog synchronization does not rewrite existing statuses, and raising the
   maximum does not change the saved fixed choice.
8. Existing `AUTO_CLAIM` rows with no amount continue to claim full value with
   no data backfill.
9. Amount/configuration changes affect all and only matching open-cycle
   occurrences allowed by the provenance rules; closed history, scheduled
   future rows, foreign-user rows, and manual overrides are unchanged.
10. The card and settings editors expose semantic labels, radio state,
    associated help/errors, keyboard behavior, pending state, and Save/Cancel.
11. `IGNORE` filtering, notification isolation, standard/custom identity,
    integrity/repair reads, and manual/AMEX `USER` provenance retain their PR
    #22 behavior.
12. Targeted pure/domain/action/component/settings tests, strict TypeScript,
    changed-source lint, static migration review, and `git diff --check` pass.
    Database deployment, production runtime, build, cron, and notification
    checks are separately authorized and reported as skipped unless approved.

## Out of Scope

- Tracking quantities such as `1 of 2 passes`, points, nights, certificates, or
  percentages independently from dollar valuation.
- A configurable automatic baseline that leaves the cycle open for reminders.
- Changing catalog or custom-benefit valuation data as part of this feature.
- Replacing existing `Float` definition/status values with a new monetary type.
- Rewriting closed historical statuses or backfilling prior unclaimed value.
- Database deployment, application deployment, production smoke tests, cron
  invocation, email/notification sends, or live AMEX activity without separate
  authorization.

## Key Decisions

- Partial auto-claim always closes the cycle; ordinary partial tracking owns the
  reminder-preserving use case.
- Full/fixed is nested configuration under `AUTO_CLAIM`, not a fourth mode.
- Fixed configuration is stored as exact USD cents; null means dynamic full.
- Non-dollar benefits without tracked dollar value remain safely binary.
- True unit-aware quantity tracking is a separate future domain project.

## Risks and Deferred Items

- The current benefit model conflates tracked dollar value with underlying
  entitlement semantics. This design stays honest at the UI boundary but does
  not solve quantity tracking.
- A positive `maxAmount` may be an estimate for a non-cash entitlement. Copy
  must consistently call it tracked/ROI value rather than consumed quantity.
- Catalog/custom maximum reductions can stale a fixed choice; runtime capping
  and visible settings warnings are required rather than mutating user choice
  implicitly.
- The existing completed-zero fallback in claimed-value projection requires
  regression coverage so zero-value automatic completion never invents value.

## Research

- [Current model and options](research/current-model-and-options.md) records the
  code/catalog evidence, considered alternatives, affected surfaces, and
  verification matrix.
