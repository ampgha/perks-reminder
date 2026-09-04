# Partial Auto-Claim Amounts — Implementation Plan

## Outcome

Ship a backward-compatible extension of `AUTO_CLAIM` that lets a user choose
either the full tracked dollar value or a positive fixed tracked dollar value
per occurrence. Both choices complete the occurrence. Benefits with no positive
tracked dollar value remain binary automatic completion at `$0` ROI.

This plan begins only after the user approves the PRD and design. Product-code
implementation must use `trellis-before-dev`; final verification must use
`trellis-check`.

## Safety and release constraints

- Do not read `.env` or display credentials.
- Do not run Prisma generation, any migration/status/database command, a
  production build, cron, notification/email delivery, provider automation, or
  deployment without satisfying the separate authorization and target checks
  in the project specifications.
- Preserve unrelated worktree changes and inspect the diff before every broad
  formatter or validation command.
- Keep the database change additive. Do not backfill preferences or statuses.
- Migration deployment must precede schema-dependent application deployment;
  checked-in SQL and application code can be reviewed together, but must not be
  released in the opposite order.

## Phase 0 — Approved-task setup

1. Run the `trellis-before-dev` skill and reload the Perks Reminder index plus
   the database, architecture/domain, deployment, verification, global-benefit,
   frontend, cross-layer, and reuse specifications listed in the task context.
2. Reconfirm host, repository root, branch, upstream, `git status`, and the
   current task. Identify any user changes that appeared after planning.
3. Mark the Trellis task as started using the repository workflow only after
   approval. Do not create a commit or push unless the user later requests it.
4. Re-read `prd.md`, `design.md`, and the research note; turn any newly
   discovered conflict into an explicit plan amendment before editing code.

Checkpoint: the task is active, instructions are loaded, and all product
decisions are resolved.

## Phase 1 — Additive persistence contract

Files:

- `prisma/schema.prisma`
- a new timestamped directory under `prisma/migrations/`
- the nearest existing migration/schema regression test, or a focused new
  static SQL test if no suitable owner exists

Steps:

1. Add nullable `autoClaimAmountCents Int?` to
   `BenefitTrackingPreference`.
2. Add hand-reviewed migration SQL for the nullable column and a named check
   constraint:
   - cents may be null;
   - non-null cents must be positive;
   - non-null cents are legal only when mode is `AUTO_CLAIM`.
3. Add a static regression proving the migration is additive and does not
   contain preference/status updates, destructive DDL, or a backfill.
4. Review compatibility explicitly: old code ignores the column; existing
   null auto preferences retain full-value behavior in new code.

Checkpoint: schema and checked-in SQL agree. Do not execute or introspect a
database, and do not generate Prisma artifacts, absent the separate database
authorization gate.

## Phase 2 — Pure configuration and amount domain

Primary files:

- `src/lib/benefit-tracking-modes.ts`
- `src/lib/__tests__/benefit-tracking-modes.test.ts`

Steps:

1. Introduce the client-safe `BenefitTrackingConfiguration` discriminated
   union for `TRACK`, `IGNORE`, `AUTO_CLAIM/FULL`, and
   `AUTO_CLAIM/FIXED(amountCents)`.
2. Normalize persistence rows in one function. Treat an absent preference as
   `TRACK`; reject malformed persisted combinations instead of silently
   changing intent.
3. Add a strict decimal-string-to-cents parser. Reject exponent notation,
   partial parses, non-finite input, more than two fractional digits, zero,
   negative values, and unsafe integers.
4. Add the single resolver for current maximum, full/fixed choice, runtime cap,
   zero-value behavior, and stale-choice metadata.
5. Add client-safe formatting/summary helpers, including `per occurrence`
   wording and tracked-value language for non-cash benefits.
6. Keep status-default generation in this module so materializers and actions
   cannot diverge.
7. Cover full/fixed/zero/capped values, rounding boundaries, bad persistence,
   all parser failures, dynamic maximum changes, and multiple-occurrence copy
   with pure tests.

Checkpoint: the complete business rule can be exercised without React,
Next.js, Prisma, authentication, or a database.

## Phase 3 — Configuration-aware preference boundary

Primary files:

- `src/lib/benefit-tracking-preferences.ts`
- `src/lib/__tests__/benefit-tracking-preferences.test.ts`
- affected materialization callers and their existing tests:
  - `src/app/api/cron/check-benefits/route.ts`
  - `src/lib/actions/cardUtils.ts`
  - the custom-benefit server action
  - `src/app/api/benefits/route.ts`

Steps:

1. Extend the shared select with `autoClaimAmountCents` and replace mode-only
   maps with complete configuration maps for both single-user and multi-user
   paths.
2. Keep `IGNORE` filtering based on `configuration.mode`; do not move filters
   into integrity, repair, or catalog-sync reads.
3. Extend planned-row processing to batch-load authoritative standard/custom
   maximums only for rows whose owner has an auto configuration. Preserve
   input order and the empty/no-auto fast paths.
4. Extend scheduled-window entry to apply the same full/fixed/zero/capped
   resolver to virgin open rows only.
5. Add the shared transaction owner for preference persistence and open-cycle
   status transitions. It must implement the exact provenance matrix in
   `design.md`, including:
   - entering auto completes all uncompleted current occurrences;
   - editing auto rewrites only eligible `AUTO`/virgin rows;
   - leaving auto reopens only `AUTO` rows;
   - `USER`, closed, future, and foreign-user rows are untouched.
6. Preserve standard/custom identity and scope every read/update by owner.
7. Cover query-count/fast-path behavior, per-owner map isolation, per-occurrence
   writes, runtime capping, transactional rollback, and exact where-clauses in
   mocked boundary tests.

Checkpoint: every creation/window/action path consumes the same configuration
resolver, and no consumer implements its own amount calculation.

## Phase 4 — Authenticated mutation surfaces

Primary files:

- `src/app/benefits/actions.ts`
- `src/app/benefits/__tests__/tracking-mode-actions.test.ts`
- `src/app/settings/benefit-tracking/actions.ts` if the settings action is
  split from its current owner
- settings action tests

Steps:

1. Extend the benefit-card action vocabulary with `autoClaimValueKind` and
   `autoClaimAmount`, validating legal field combinations before database work.
2. Authenticate, reload the owned effective status/current maximum, and invoke
   the shared transaction owner. Never trust client amount limits or identity.
3. Add a settings edit action keyed by `preferenceId + userId`; use the same
   not-found result for missing and foreign rows.
4. Route the existing reset behavior through the `TRACK` branch of the shared
   mutation helper.
5. Return stable success/error shapes usable by both editors. Revalidate
   `/benefits`, `/`, and `/settings/benefit-tracking` only after a successful
   transaction.
6. Test unauthenticated, malformed, sub-cent, zero/negative, above-maximum,
   zero-value fixed, missing/foreign, standard/custom, full/fixed/capped,
   idempotent, database-failure, revalidation, and provenance cases.

Checkpoint: both UI entry points have identical domain behavior and neither
can mutate another user's status or preference.

## Phase 5 — Projection and ROI correctness

Primary files:

- `src/lib/benefit-dashboard.ts`
- `src/lib/benefit-dashboard-client.ts`
- `src/lib/__tests__/benefit-dashboard.test.ts`
- `src/lib/__tests__/benefit-dashboard-load.test.ts`
- any focused client-accounting test owner

Steps:

1. Project one normalized `trackingConfiguration` plus the fields needed for
   current maximum, cadence, occurrence count, and capped warning.
2. Carry `claimSource` into the browser-safe claimed-value input.
3. Narrow the legacy completed-zero fallback to rows with null provenance.
   Explicit `AUTO` or `USER` zero must contribute zero.
4. Verify claimed totals and ROI use actual fixed `usedAmount`, while completion
   still removes the occurrence from Upcoming/reminder attention.
5. Add regressions for `$15 of $25`, full `$25`, explicit completed `$0`, legacy
   completed-zero fallback, changed maximums, and multiple occurrences.

Checkpoint: dashboard attention state and financial value are independent and
correctly projected.

## Phase 6 — Shared editor, card, and settings UI

Primary files:

- a shared component such as `src/components/BenefitTrackingEditor.tsx`
- `src/components/BenefitCardClient.tsx`
- `src/components/__tests__/BenefitCardClient.test.tsx`
- a focused shared-editor test
- `src/app/settings/benefit-tracking/page.tsx`
- `src/app/settings/benefit-tracking/BenefitTrackingClient.tsx`
- focused settings tests

Steps:

1. Build a semantic shared editor with top-level mode choice and a nested
   `fieldset` for full versus custom tracked value. Associate help and errors,
   and support keyboard operation.
2. For positive maximums, offer dynamic full and an intentionally empty custom
   dollar input. Explain that custom value affects claimed value/ROI and use
   `per occurrence` when applicable.
3. For zero/non-positive maximums, show binary automatic completion and the
   explicit `$0` ROI consequence; never show the fixed-dollar field.
4. Require Save, provide Cancel, prevent duplicate submissions while pending,
   preserve user input on server validation failure, and announce errors.
5. On the benefit card, show a collapsed configuration summary and render a
   completed partial amount as `$15 of $25` while retaining `Claimed`.
6. On settings, render every non-default preference with card identity,
   cadence, full/fixed/zero/ignored summary, current effective value, and a
   stale/capped warning. Allow direct switching among all modes while keeping a
   one-click `Track normally` action.
7. Test semantic roles/labels, conditional fields, zero-value state, save and
   cancel, pending/error behavior, summary copy, stale warning, ignored-row
   editing, and multiple-occurrence wording.

Checkpoint: the same concepts and validation language appear on both surfaces,
including for an ignored benefit reachable only from settings.

## Phase 7 — Documentation and compatibility audit

Files:

- `docs/benefit-tracking-modes.md`
- any directly affected public type/test fixtures

Steps:

1. Document completion versus claimed dollar value, full versus fixed behavior,
   zero-value/non-cash handling, per-occurrence behavior, definition-value
   drift, provenance/manual override, cycle boundaries, reset, and release
   ordering.
2. Audit all references to `BenefitTrackingMode`, preference selects,
   `AUTO_CLAIM`, `claimSource`, `usedAmount`, and completed-zero fallback with
   `rg`; update every affected fixture deliberately.
3. Confirm catalog sync and repair paths remain outside preference-driven
   status mutation.

Checkpoint: code, tests, and documentation describe the same contract and no
mode-only consumer accidentally discards the fixed configuration.

## Phase 8 — Verification and handoff

Run the narrowest relevant checks after each phase, then the combined safe
gate. Exact paths may be adjusted to match newly added test files.

```bash
npm test -- --runInBand \
  src/lib/__tests__/benefit-tracking-modes.test.ts \
  src/lib/__tests__/benefit-tracking-preferences.test.ts \
  src/app/benefits/__tests__/tracking-mode-actions.test.ts \
  src/lib/__tests__/benefit-dashboard.test.ts \
  src/lib/__tests__/benefit-dashboard-load.test.ts \
  src/components/__tests__/BenefitCardClient.test.tsx

npm test -- --runInBand \
  src/app/api/cron/check-benefits/__tests__/route.test.ts \
  src/lib/actions/__tests__/cardUtils.test.ts \
  src/app/api/benefits/__tests__/route.test.ts

npx tsc --noEmit --pretty false --incremental false
npx eslint <changed TypeScript and TSX files>
npm run check:public-db
git diff --check
python3 ./.trellis/scripts/get_context.py --mode packages
```

Then:

1. Run the full Jest suite with `npm test -- --runInBand` if targeted checks
   and resource limits make it safe; otherwise report the exact reason it was
   skipped.
2. Statically inspect the complete diff and every untracked file. Confirm no
   credentials, generated files, unrelated changes, or migration surprises.
3. Use `trellis-check` for spec compliance, cross-layer flow, reuse, types,
   lint, and test review. Fix findings and rerun affected checks.
4. Report separately:
   - passed local static/unit/component checks;
   - intentionally skipped database/build/external/production checks;
   - the required migration-before-application release gate;
   - any pre-existing failures.

Do not claim production or database proof from these local checks.

## Risk checkpoints and rollback

- **Prisma client coupling:** application compilation may require regenerated
  client types. Stop at the documented authorization gate rather than manually
  editing generated output.
- **Definition drift:** the saved fixed cents remain untouched; only the
  effective value is capped. Test lower, zero, and later-raised maximums.
- **Provenance:** every current-cycle update needs direct assertions for
  `AUTO`, `USER`, and null sources; this is the primary data-loss boundary.
- **Multi-occurrence/multi-user:** assert every occurrence is handled and every
  user resolves through their own map.
- **ROI fallback:** explicit completed zero must never inherit a later maximum.
- **Rollback before release:** revert application changes and leave the
  additive nullable column unused.
- **Rollback after migration:** roll application code back safely; do not drop
  the column or constraint as part of routine rollback. Destructive schema
  reversal requires a separately reviewed operation.
- **No live status rollback is expected:** implementation verification uses
  mocks/static checks only unless a separately authorized disposable database
  workflow is established.

## Definition of done

- Every acceptance criterion in `prd.md` has a named automated test or an
  explicit static-review check.
- Full, fixed, capped, zero-value, manual-override, reset, and per-occurrence
  behavior agree across persistence, actions, materialization, dashboard,
  benefit card, settings, and docs.
- All authorized verification passes with no new warnings or errors.
- Database/build/deployment/external effects remain unperformed unless the user
  separately authorizes them under project policy.
