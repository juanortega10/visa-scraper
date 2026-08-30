-- Sello de emision del authenticity_token. Permite precalentar el token fuera del
-- camino critico: el run siguiente lo hereda fresco y no pide la pagina del
-- appointment con el cupo a la vista. Ver VisaClient.ensureTokens().
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "tokens_refreshed_at" timestamp;
