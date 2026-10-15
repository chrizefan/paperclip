-- DIG-3729: append-and-notify standing-issue reuse for periodic routines.
--
-- routines.standing_issue_id is an OPT-IN pointer to the issue every firing appends
-- its tick note to. It is nullable and is never auto-adopted, so a routine keeps
-- minting one issue per firing until an operator sets this explicitly.
--
-- The lookup is by primary key and company, never by the dispatch fingerprint: the
-- fingerprint covers routine_revision_id and routine_env_fingerprint, so editing a
-- routine orphans the match. The id does not move.
--
-- Additive only: new nullable column, one new index, no backfill, no constraint
-- rewrite. The index is on a 14-row table (packages/db/src/table-size-estimates.ts
-- records localRows: 14 for routines), so it is created inline rather than
-- CONCURRENTLY.
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "standing_issue_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'routines_standing_issue_id_issues_id_fk'
  ) THEN
    ALTER TABLE "routines"
      ADD CONSTRAINT "routines_standing_issue_id_issues_id_fk"
      FOREIGN KEY ("standing_issue_id") REFERENCES "issues"("id")
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "routines_standing_issue_idx" ON "routines" ("standing_issue_id");
