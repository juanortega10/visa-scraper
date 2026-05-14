-- Adds per-bot visa type classification captured during discovery.
-- visa_category:        normalized code (e.g. "B1/B2", "F1", "J1", "TN") — indexable for stats grouping.
-- visa_type_raw:        full label as shown in the portal (locale-specific).
-- applicant_visa_types: per-applicant raw labels (jsonb array, parallel to applicant_ids when complete).
--
-- All nullable; new bots populate from discovery, existing bots populated by backfill script.

ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "visa_category" varchar(20);
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "visa_type_raw" text;
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "applicant_visa_types" jsonb;
