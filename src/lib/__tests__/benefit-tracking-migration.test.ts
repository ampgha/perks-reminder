import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationPath = join(
  process.cwd(),
  'prisma/migrations/20260831000000_add_partial_auto_claim_amount/migration.sql'
);

describe('partial auto-claim migration', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  it('adds only the nullable cents column and its compatibility check', () => {
    expect(sql).toContain('ADD COLUMN "autoClaimAmountCents" INTEGER');
    expect(sql).toContain('"autoClaimAmountCents" > 0');
    expect(sql).toContain('"mode" <> \'AUTO_CLAIM\'');
    expect(sql).toContain('"autoClaimAmountCents" IS NULL');
  });

  it('does not backfill, rewrite, or destructively alter existing data', () => {
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bNOT\s+NULL\b/i);
  });
});
