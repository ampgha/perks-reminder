# Partial Auto-Claim: Current Model and Options

## Executive finding

The application already separates two facts that the current UI often presents
together:

1. `BenefitStatus.isCompleted` says whether a Benefit Cycle needs more user
   attention.
2. `BenefitStatus.usedAmount` is a dollar-valued contribution to claimed value
   and ROI.

A partial automatic claim should therefore be modeled as a completed cycle with
a configured claimed dollar value below the benefit's full tracked value. It
must not put counts, points, nights, or passes into `usedAmount`, because every
dashboard total treats `usedAmount` as dollars.

## Repository evidence

### Amount semantics

- `Benefit.maxAmount`, `PredefinedBenefit.maxAmount`, and
  `BenefitStatus.usedAmount` are nullable/required Prisma `Float` fields
  (`prisma/schema.prisma:147-148`, `:195-196`, `:245-254`).
- Benefit cards prefix positive `maxAmount` and `usedAmount` values with `$`
  (`src/components/BenefitCardClient.tsx:276-303`, `:668-755`).
- Dashboard, home, category summaries, and card ROI sum `usedAmount` as claimed
  monetary value (`src/lib/benefit-dashboard-client.ts:119-156`,
  `src/lib/benefit-dashboard.ts:206-275`, `:491-498`).
- Custom-benefit creation labels `maxAmount` as `Value ($)` and describes it as
  value per cycle (`src/app/benefits/custom/page.tsx:142-167`).
- `percentage` exists in both definition models but every one of the 134 current
  static catalog benefits has `percentage: 0`; it is not an available unit or
  partial-claim mechanism.

### Catalog reality

Programmatic inspection of `predefinedCardsData` found 37 cards and 134
benefits:

- 20 benefits have `maxAmount: 0`, including free-night awards, bonus
  points/miles, lounge passes, companion awards, elite-night credits, status,
  and variable-value features.
- Several non-cash entitlements have a positive estimated dollar value, such as
  two United Club passes at `$100`, two EarlyBird credits at `$50`, 6,000
  Southwest points at `$78`, and four Admirals Club passes at `$300`.
- Three definitions use multiple occurrences; the existing preference applies
  to the benefit and PR #22 applies the amount independently to every open
  occurrence.

Consequently, neither description parsing nor `maxAmount > 0` can identify the
underlying real-world unit. What `maxAmount > 0` *does* reliably identify is that
the product currently assigns a dollar value that participates in ROI.

### Current automatic-claim paths

- `BenefitTrackingPreference` stores only identity plus `mode`; absence means
  `TRACK` (`prisma/schema.prisma:278-295`).
- `initialStatusFieldsForTrackingMode` always completes `AUTO_CLAIM` at the
  current `maxAmount`, or `0` when no positive value exists
  (`src/lib/benefit-tracking-modes.ts:128-140`).
- `applyTrackingModesToPlannedRows` applies that behavior to all materialization
  paths; `claimWindowEntryAutoClaims` handles already-materialized future rows
  as their windows open (`src/lib/benefit-tracking-preferences.ts:133-261`).
- The mode action applies to all occurrences in the open cycle, clears
  `isNotUsable`, and may reopen only `AUTO` rows when leaving auto-claim
  (`src/app/benefits/actions.ts:805-904`).
- Manual and confirmed AMEX mutations stamp `claimSource: USER`; future
  window-entry automation touches only virgin `claimSource: null` rows.
- `IGNORE` remains a read filter; integrity and repair paths intentionally see
  the underlying statuses.

## Recommended persistence model

Keep the existing three tracking modes. Add one nullable preference field:

```text
autoClaimAmountCents Int?
```

Interpret it only when `mode = AUTO_CLAIM`:

| Mode/configuration | Meaning |
| --- | --- |
| `AUTO_CLAIM`, cents `NULL` | Full tracked value; dynamically use the current `maxAmount` |
| `AUTO_CLAIM`, cents positive | Fixed claimed dollar value per occurrence |
| `IGNORE` or `TRACK` | Cents must be `NULL` |

Why cents instead of another float:

- the new value is explicitly USD claimed value, not an arbitrary benefit unit;
- integer cents make the stored user choice exact;
- existing `usedAmount` remains unchanged for compatibility and receives
  `cents / 100` at materialization;
- a nullable field gives every existing `AUTO_CLAIM` row full-value semantics
  without a data backfill.

The application must cap a fixed value at the current positive `maxAmount` when
applying it. This prevents overstated ROI if a catalog or custom-benefit edit
later lowers the maximum. The saved choice remains visible with a warning so
the user can edit it. If the maximum increases, a fixed choice stays fixed while
the full-value choice follows the new maximum.

Suggested database constraint:

- non-null cents must be positive;
- non-`AUTO_CLAIM` rows must have null cents.

The server remains responsible for ownership, finite decimal parsing, cent
normalization, and validation against the current effective definition because
a database check cannot compare a polymorphic preference with either definition
table's current maximum.

## Recommended domain contract

Use a discriminated client/domain configuration even though persistence is
compact:

```ts
type BenefitTrackingConfiguration =
  | { mode: 'TRACK' }
  | { mode: 'IGNORE' }
  | { mode: 'AUTO_CLAIM'; value: { kind: 'FULL' } }
  | { mode: 'AUTO_CLAIM'; value: { kind: 'FIXED'; amountCents: number } };
```

Central pure helpers should:

- parse persistence into this configuration;
- resolve full/fixed/capped effective values;
- derive auto-claimed status fields;
- produce a client-safe summary such as `Full value ($25)` or `$15 each cycle`.

The database-aware map must carry the configuration, not only the mode. All
existing filters continue to inspect `.mode`; all materialization paths use the
same amount resolver.

## Recommended cycle behavior

- A fixed partial auto-claim writes `isCompleted: true`, the configured/capped
  `usedAmount`, `completedAt: now`, `claimSource: AUTO`, and
  `isNotUsable: false`.
- It closes the cycle so the benefit leaves Upcoming and notification flows,
  while only the configured value contributes to ROI.
- Setting auto-claim from another mode applies to every uncompleted occurrence
  in the currently open cycle, preserving PR #22's existing behavior.
- Editing full/fixed configuration while already in auto-claim updates only
  open-cycle rows still stamped `AUTO`; manual `USER` overrides stay untouched.
- Leaving auto-claim reopens only open-cycle `AUTO` rows, exactly as today.
- Closed history and scheduled future cycles remain immutable. Scheduled rows
  take the configuration when their window opens.
- For multiple-occurrence definitions, the configured value applies to each
  occurrence, matching current full auto-claim semantics. UI copy must say
  `per occurrence` when the definition has more than one.

## Recommended non-dollar behavior

### No tracked dollar value (`maxAmount <= 0`)

Offer only `Mark as claimed automatically`. Each cycle becomes completed with
`usedAmount: 0`; it leaves the to-do list and contributes `$0` to ROI. Do not
show a `$0` input or a partial option.

### Estimated dollar value on a non-cash entitlement (`maxAmount > 0`)

The product already renders and totals that value as dollars. The editor may
offer full or custom **tracked value**, with helper text explaining that the
number is what counts toward claimed value/ROI and does not track passes,
points, or nights.

### True quantity tracking

Tracking `1 of 2 passes`, `5,000 points`, or one certificate requires a separate
model with an explicit unit, available quantity, used quantity, and an optional
USD valuation/conversion rule. Reusing `usedAmount` for those quantities would
make ROI incorrect. That larger domain migration should be deferred from this
MVP unless quantity tracking itself is a product requirement.

The existing AMEX observation contract already demonstrates the safe vocabulary
`USD | count | points | percent | unknown`, but that source-observation type is
not a durable Benefit/BenefitStatus model and should not be reused by casting.

## Recommended card interaction

Keep `TRACK`, `AUTO_CLAIM`, and `IGNORE` as the top-level mutually exclusive
choices. Selecting auto-claim reveals a nested semantic radio group and an
explicit Save action:

1. `Full tracked value — $25.00 each cycle` (default, follows later value
   changes).
2. `Custom tracked value` with a `$` input and helper text `Amount counted
   toward claimed value and ROI each cycle`.

For zero-value benefits, replace the nested group with explanatory copy:
`This benefit has no tracked dollar value. It will be marked claimed each cycle
and add $0 to ROI.`

Separate full/custom controls are preferable to one pre-populated editable
number. A single `$25` field cannot tell the user whether `$25` means dynamic
“full value” or a fixed amount that should remain `$25` after a catalog change.
The custom input can use the current maximum as a placeholder, but should
require an intentional value rather than silently saving a fixed copy of the
maximum.

Use native radios/fieldset/legend, an associated currency input, described-by
help/error text, explicit Save/Cancel, pending state, and server-returned
validation errors. Do not save simply because a nested radio receives focus.

## Recommended viewing and editing

### Benefit card

The collapsed control should expose the exact configuration:

- `Auto: full ($25)`
- `Auto: $15/cycle`
- `Auto: claimed` for no-dollar-value benefits
- `Ignored`
- `Tracking`

Completed rows with `usedAmount < maxAmount` must display `$15 of $25` even
though they are completed; the current card only shows this breakdown for an
incomplete partial row and would otherwise misleadingly show `$25`.

### Benefit Tracking settings

The settings row must show the same summary plus card identity and cadence. It
must offer Edit in addition to `Track normally`, because ignored benefits are
not reachable from the dashboard. The editor should allow moving among all
three modes, not only changing an existing auto amount.

The card and settings surfaces should share the client-safe configuration,
labels, validation copy, and editor component where practical. Their server
actions differ by authority: the card starts from an owned status ID; settings
starts from an owned preference ID.

## Alternatives considered

### Store a percentage of `maxAmount`

Rejected for the MVP. Users asked for a stable amount such as `$15`; percentage
copy is less direct, changes value when catalog terms change, and does nothing
for benefits without a dollar maximum.

### Add `AUTO_CLAIM_PARTIAL` as another tracking mode

Rejected. Full versus fixed amount is configuration within the same behavioral
mode. A fourth mode would duplicate filtering, reset, provenance, and UI logic.

### Store only one editable amount pre-filled to the maximum

Rejected. It loses the important dynamic-full versus fixed-value distinction.

### Introduce complete unit-aware benefit/status modeling now

Deferred. It is the correct foundation for true quantity tracking but affects
the catalog source, global synchronizer, effective projection, legacy/category
repair fingerprints, AMEX authority, custom-benefit APIs, dashboard/ROI logic,
and migrations. It is substantially larger than partial automatic claimed
value and is not required to keep non-dollar benefits safely auto-completable.

## Affected implementation surfaces

- Prisma schema and additive migration for the nullable cents field/check.
- `benefit-tracking-modes.ts`: configuration, validation, amount resolution,
  summaries, and status defaults.
- `benefit-tracking-preferences.ts`: selected field/map shape, materialization,
  and window-entry claiming.
- Benefit mode actions: card/status-based set, settings/preference-based edit,
  reset, current-cycle transitions, ownership, and revalidation.
- Dashboard DTO/projection: carry configuration to cards and correctly render a
  completed partial value.
- `BenefitCardClient`: nested editor and configuration summary.
- Benefit Tracking settings server page/client: load current maximum/cadence,
  summarize, edit, and reset.
- Existing materialization callers remain centralized but their mocks/tests
  need the expanded selected preference shape.
- Documentation must distinguish claimed state, claimed dollar value, and
  unsupported quantity tracking, and retain migration-before-deploy ordering.

## Required verification coverage

- Pure configuration: full, fixed, cent conversion, zero maximum, fixed cap,
  invalid values, and existing-row compatibility.
- Database helpers: single/multi-user isolation, input order, full/fixed planned
  rows, zero-value rows, window entry, and no-query fast paths.
- Actions: auth, input validation, ownership, standard/custom identity,
  create/update/delete, same-mode amount edit, all open occurrences, closed and
  scheduled immutability, manual provenance, not-usable transition, persistence
  failure, and revalidation.
- UI: full/custom/zero-value variants, semantic radio state, currency labeling,
  validation, summary copy, pending/errors, Save/Cancel, settings edit/reset,
  multiple-occurrence copy, and completed-partial amount display.
- Compatibility: existing null-amount auto preferences remain full-value;
  `IGNORE` filtering and integrity/repair behavior do not change; confirmed
  AMEX/manual writes remain `USER`.
- Static migration SQL review, targeted Jest suites, strict TypeScript,
  changed-source lint, and `git diff --check`. Database deployment, build, cron,
  notification, and production checks remain separate authorization gates.

## Resolved product decision

The user agreed that a partial automatic claim closes the cycle. Leaving the
remainder open would keep the benefit in Upcoming and notification flows,
defeating auto-claim's purpose. Ordinary partial tracking owns the separate
intent to record progress while continuing reminders; the auto-claim editor
will not add a keep-open option.
