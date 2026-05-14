-- Adds canonical server-side visa class ID from the applicant edit page select.
-- Populated asynchronously by enrichBotVisaType (fire-and-forget after bot creation).
-- Examples: 1=B1, 2=B1/B2, 3=B2, 11=F1, 22/88=J1, 30=M1, 49=TN.

ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "visa_class_id" integer;
