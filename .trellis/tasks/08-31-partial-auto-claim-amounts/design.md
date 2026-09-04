# Partial Auto-Claim Amounts — Technical Design

## 1. Design summary

Extend `AUTO_CLAIM` with an optional fixed claimed dollar value while preserving
the three-mode model introduced by PR #22.

- `autoClaimAmountCents = NULL` means full tracked value.
- Positive cents mean a fixed claimed value per occurrence.
- Both variants complete the occurrence and silence further attention for that
  cycle.
- Benefits without a positive tracked dollar value remain binary automatic
  completion at `$0` ROI.
- True points/pass/night quantity tracking remains outside this design.

The implementation extends the existing pure owner
`benefit-tracking-modes.ts` and database owner
`benefit-tracking-preferences.ts`; no consumer derives the semantics locally.

## 2. Current boundaries retained

- `src/lib/effective-benefit.ts` remains the canonical standard/bridge/custom/
  legacy status projection.
- `src/lib/benefit-tracking-preferences.ts` remains the only user-facing
  tracking-preference database boundary.
- `src/lib/benefit-dashboard.ts` remains dashboard/home orchestration;
  `benefit-dashboard-client.ts` remains browser-safe display logic.
- Server actions authenticate, validate, reload owned state, invoke the domain
  owner, and revalidate affected routes.
- Integrity, repair, and catalog synchronization do not use user-facing
  preference filtering and do not rewrite statuses for this feature.

## 3. Data model

### 3.1 Prisma field

Add to `BenefitTrackingPreference`:

```prisma
autoClaimAmountCents Int?
```

The field is cents because it represents an exact user-selected USD claimed
value. It does not represent an underlying benefit quantity.

### 3.2 Persistence truth table

| `mode` | cents | Persistent meaning |
| --- | ---: | --- |
| `TRACK` | `NULL` | Tolerated schema state, but application deletes the row |
| `IGNORE` | `NULL` | Hide/exclude without deleting statuses |
| `AUTO_CLAIM` | `NULL` | Dynamic full tracked value |
| `AUTO_CLAIM` | `> 0` | Fixed tracked value per occurrence |
| non-auto | non-null | Invalid |
| auto | `<= 0` | Invalid |

Add an additive SQL check equivalent to:

```sql
CHECK (
  ("mode" = 'AUTO_CLAIM' AND
    ("autoClaimAmountCents" IS NULL OR "autoClaimAmountCents" > 0))
  OR
  ("mode" <> 'AUTO_CLAIM' AND "autoClaimAmountCents" IS NULL)
)
```

Do not add a data backfill. Existing auto preferences receive full-value
semantics from null naturally.

### 3.3 Why not change definition/status money fields

`maxAmount` and `usedAmount` are existing `Float` contracts across effective
projection, AMEX, migrations, dashboard, and tests. Replacing them is unrelated
to the user outcome and would broaden migration risk. Convert cents to the
existing status float only at the domain boundary.

## 4. Domain types and normalization

Define one client-safe discriminated union in `benefit-tracking-modes.ts`:

```ts
export type BenefitTrackingConfiguration =
  | { mode: 'TRACK' }
  | { mode: 'IGNORE' }
  | { mode: 'AUTO_CLAIM'; value: { kind: 'FULL' } }
  | {
      mode: 'AUTO_CLAIM';
      value: { kind: 'FIXED'; amountCents: number };
    };
```

Persistence records include `autoClaimAmountCents`. A single normalizer converts
them to the union and fails closed to `TRACK` only for an absent preference;
malformed persisted rows should throw a stable invariant error rather than
silently reinterpret user intent.

### 4.1 Amount helpers

Pure helpers own:

- strict dollars-to-cents parsing from a decimal form string;
- cents-to-dollar display/value conversion;
- full/fixed resolution against `maxAmount`;
- stale fixed-value detection and capping;
- status defaults for materialization/current-cycle updates;
- display summaries and cadence wording.

Resolution result:

```ts
interface ResolvedAutoClaimValue {
  configuredAmountCents: number | null;
  effectiveAmountCents: number;
  wasCapped: boolean;
  hasTrackedDollarValue: boolean;
}
```

Rules:

1. Normalize positive finite `maxAmount` to nearest cent; null, non-finite,
   zero, or negative becomes zero.
2. Full uses normalized maximum.
3. Fixed uses `min(configured, maximum)` when maximum is positive.
4. A stale fixed value with a now-zero maximum resolves to zero.
5. The saved fixed value is never silently rewritten by resolution.

New user input is stricter than stale persistence: FIXED requires a positive
current maximum and cents in `1..maximumCents`. Only subsequent definition drift
can produce `wasCapped`.

### 4.2 Status fields

For either auto variant:

```ts
{
  isCompleted: true,
  completedAt: now,
  usedAmount: effectiveAmountCents / 100,
  claimSource: 'AUTO'
}
```

Current-cycle mutation additionally sets `isNotUsable: false` atomically.

## 5. End-to-end data flow

```text
Benefit card
  status id + selected union
    -> validate FormData
    -> load owned effective status/current max
    -> shared preference mutation
    -> preference + allowed open statuses in one transaction
    -> revalidate dashboard/home/settings

Settings row
  preference id + selected union
    -> validate FormData
    -> load owned preference/target/current max
    -> same shared preference mutation
    -> same transaction behavior
    -> revalidate dashboard/home/settings

New/scheduled cycle
  planned status identity
    -> load configuration map by owning user
    -> load authoritative current max
    -> resolve full/fixed/capped value
    -> insert or window-entry update with AUTO provenance

Dashboard/settings read
  persistence record
    -> normalize once to configuration union
    -> project union + current max/cadence
    -> shared summary/editor rendering
```

## 6. Preference loading and maps

Replace mode-only maps with configuration maps:

```ts
type BenefitTrackingConfigurationMap =
  ReadonlyMap<string, BenefitTrackingConfiguration>;
```

`PREFERENCE_SELECT` adds `autoClaimAmountCents`. Existing functions may retain
their names only if their return type/name stays truthful; preferably rename:

- `loadBenefitTrackingConfigurations`
- `loadBenefitTrackingConfigurationsByUser`
- `resolveBenefitTrackingConfiguration`
- `buildBenefitTrackingConfigurationMap`

`excludeIgnoredBenefits` consults `configuration.mode`. The multi-user path
continues resolving each status against its own owner.

## 7. Materialization and window entry

### 7.1 Planned rows

`applyTrackingModesToPlannedRows` (renamed if clarity warrants) must:

1. return untouched defaults immediately for an empty row list;
2. load configuration once for distinct owners;
3. skip definition amount queries when no auto configuration exists;
4. batch-load standard/custom current `maxAmount` only for auto rows;
5. return defaults in exact input order;
6. use one pure resolver for full, fixed, zero-value, and capped cases.

All four callers remain routed through this helper: cron materialization, card
creation, custom server action, and custom API route.

### 7.2 Window entry

`claimWindowEntryAutoClaims` continues to select all auto preferences and
update only virgin open rows:

```text
isCompleted false
isNotUsable false
usedAmount 0
claimSource NULL
open-cycle dates
exact owner + benefit identity
```

It uses the same resolver and counts affected rows. Fixed configuration is per
occurrence because every matching status receives the same update.

## 8. Shared preference mutation

Add a database-aware mutation owner in
`benefit-tracking-preferences.ts`, conceptually:

```ts
applyBenefitTrackingConfiguration(database, {
  userId,
  target,
  maximumAmount,
  configuration,
  now,
  expectedPreferenceId?,
}): Promise<BenefitTrackingConfiguration>
```

The helper owns the transaction, prior-preference lookup, preference
create/update/delete, and status transitions. Actions do not duplicate this
matrix.

### 8.1 Persistence matrix

- `TRACK`: delete the existing row; settings supplies
  `expectedPreferenceId` so a missing/foreign row fails rather than deleting by
  resemblance.
- `IGNORE`: create/update mode and clear cents.
- `AUTO_CLAIM FULL`: create/update mode and clear cents.
- `AUTO_CLAIM FIXED`: create/update mode and store cents.
- An unchanged normalized configuration is an idempotent success with no
  unnecessary preference update.

### 8.2 Open-cycle transition matrix

| Previous | Requested | Open status update |
| --- | --- | --- |
| non-auto | auto | Complete all uncompleted matching occurrences at resolved value; clear not-usable |
| auto | changed full/fixed | Recompute matching `AUTO` occurrences plus any virgin null-source occurrence; skip `USER` |
| auto | same config | No status rewrite |
| auto | track/ignore | Reopen completed matching `AUTO` occurrences only |
| track/ignore | track/ignore | No status rewrite |

Every update includes authenticated `userId`, exact standard/custom target, and
`cycleStartDate <= now <= cycleEndDate`. Future/closed rows cannot match.

The non-auto-to-auto row preserves PR #22's explicit override behavior for
uncompleted/not-usable current rows. Completed `USER` state is never changed.
Once auto is active, a manual `USER` override is protected from configuration
edits and window-entry processing for that cycle.

## 9. Server action contracts

### 9.1 Form vocabulary

```text
trackingMode: TRACK | AUTO_CLAIM | IGNORE
autoClaimValueKind: FULL | FIXED       # required only for AUTO_CLAIM
autoClaimAmount: decimal string        # required only for FIXED
benefitStatusId: cuid                  # card surface
preferenceId: cuid                     # settings surface
```

Reject unknown/extra semantic combinations before a write. Parse the decimal
string exactly to cents; do not use permissive `parseFloat` behavior such as
accepting `15abc`.

### 9.2 Card action

The existing set action:

1. authenticates before reads;
2. validates the complete form vocabulary;
3. loads the owned effective status by `userId + statusId`;
4. derives standard/custom target and current authoritative maximum;
5. invokes the shared mutation;
6. returns an explicit success/configuration shape;
7. revalidates `/benefits`, `/`, and `/settings/benefit-tracking`.

### 9.3 Settings action

A settings edit action:

1. authenticates and validates before database work;
2. loads exactly one preference by `id + userId` with its standard/custom
   definition maximum and occurrence count;
3. fails with the same not-found/permission response for missing/foreign rows;
4. invokes the shared mutation with `expectedPreferenceId`;
5. returns the same configuration shape and revalidates the same routes.

The existing reset action should become the TRACK case of this path or delegate
to the same helper so reset semantics cannot drift.

## 10. Dashboard projection and accounting

`DisplayBenefitStatus` carries one optional/normalized
`trackingConfiguration`, not parallel mode and amount fields. The default when
absent is `{ mode: 'TRACK' }`.

### 10.1 Completed partial display

The card must derive claimed value using the browser-safe accounting helper.
When a completed status has a claimed value between zero and maximum, render
`$15 of $25` while retaining the `Claimed` status pill. Completion means no
remaining attention; it does not imply full ROI value.

### 10.2 Completed-zero legacy fallback

Today, `resolveBenefitClaimedValue` treats completed zero as the current maximum.
Retain that only for legacy rows with `claimSource == null`. An explicit
`AUTO`/`USER` zero must count zero, preventing a zero-value automatic claim from
gaining invented historical ROI if a definition later receives a positive
maximum.

Extend the client-safe status input with optional `claimSource` and add direct
regressions for null/AUTO/USER completed-zero cases.

## 11. User interface design

### 11.1 Shared editor

Create a reusable client component or tightly shared primitives for:

- top-level mode radio/pressed selection;
- conditional full/fixed fieldset;
- currency input and validation/help identifiers;
- zero-value explanatory state;
- summary formatting;
- Save/Cancel/pending/error behavior.

Use semantic `fieldset`/`legend` and native radio inputs for the nested mutually
exclusive selection. Conditional content remains adjacent to its controlling
radio. Do not use a menu role.

### 11.2 Card copy

For a positive maximum:

```text
Automatically claim
  ( ) Full tracked value — $25.00 each cycle
      Follows the benefit value if it changes.
  ( ) Custom tracked value
      [$ amount]
      Amount counted toward claimed value and ROI each cycle.
```

For no positive maximum:

```text
Automatically mark as claimed
This benefit has no tracked dollar value. It will add $0 to ROI.
```

Use `per occurrence` rather than `each cycle` when
`occurrencesInCycle > 1`.

### 11.3 Settings

Each row receives current maximum, occurrence count, cadence, saved
configuration, effective resolved value, and capped warning. The same editor is
available inline or in an accessible disclosure. Retain a direct `Track
normally` action.

Because ignored rows exist only here, their editor can switch directly to auto
without first resetting and rediscovering the benefit.

## 12. Compatibility and migration

- Migration is additive: one nullable integer and one check; no existing row
  update and no existing status change.
- Old application code ignores the new column, so deploy migration first.
- New code interprets every existing null auto amount as full value.
- Rolling application code back leaves an unused nullable column and does not
  lose preferences; old code resumes full-value behavior for all auto rows.
- Dropping the column is not part of rollback and would be a separate
  destructive operation.
- Prisma client generation, development migration execution, production
  migration/status checks, and deployment are separate gates under the project
  database/deployment specs.

Required release order:

```text
review additive SQL
  -> separately authorized production migration
  -> verify exact migration/column/constraint
  -> merge/deploy schema-dependent application
```

## 13. Error and edge-case matrix

| Case | Required result |
| --- | --- |
| Unauthenticated | Reject before user-owned read/write |
| Unknown mode/kind or illegal field combination | Stable validation error; no DB work |
| Malformed, non-finite, sub-cent, zero, negative fixed input | Stable validation error; no write |
| Fixed input above current maximum | Stable validation error; no write |
| Fixed input for zero-value benefit | Stable validation error; UI does not offer it |
| Missing/foreign status or preference | Not-found/permission result; no write |
| Existing fixed value above later maximum | Resolve capped; preserve saved cents; warn |
| Existing auto preference with null cents | Full value, unchanged compatibility |
| Empty planned batch / no auto preferences | No avoidable definition queries/writes |
| Multiple users | Resolve each row against its owner's configuration |
| Multiple occurrences | Apply same configured value to all matching open occurrences |
| Closed/future status | Never match mutation where-clause |
| Current manual override | Configuration edit/reset never overwrites `USER` |
| Persistence error | Transaction rolls back; no revalidation/success |

## 14. Alternatives rejected or deferred

- Percentage of maximum: indirect UX, changes with catalog value, and does not
  help zero-value benefits.
- Fourth `AUTO_CLAIM_PARTIAL` mode: duplicates one behavioral mode across all
  filters, transitions, and UIs.
- One pre-populated editable amount: cannot distinguish dynamic full from a
  fixed amount equal to today's maximum.
- User-selectable keep-open toggle: conflates auto-claim with ordinary partial
  tracking and adds reminder semantics to every layer.
- Full unit-aware quantity refactor: correct for `1 of 2 passes`, but a separate
  catalog/status/ROI project with substantially larger migration scope.

## 15. Verification strategy

Use direct pure tests for configuration/cents/resolution, mocked Prisma/action
tests for authorization and exact writes, React Testing Library for semantic UI,
and a static migration SQL test/review. Then run strict TypeScript,
changed-source ESLint, affected safe invariants, and `git diff --check`.

Do not use a production build, Prisma migration/status command, database-backed
dry-run, cron, notification, email, provider, or production probe as routine
implementation verification.
