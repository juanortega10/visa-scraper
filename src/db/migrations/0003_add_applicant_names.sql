-- Full applicant names parsed from the /groups page, so the dashboard can show
-- who a bot belongs to instead of raw numeric applicant IDs.
-- Written at bot creation (from the discovery result) and by
-- scripts/backfill-visa-types.ts for pre-existing bots.

ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "applicant_names" jsonb;
