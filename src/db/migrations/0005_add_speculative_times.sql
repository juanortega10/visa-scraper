-- Horas a adivinar por bot, en orden de prioridad. NULL = constante global.
-- La constante ['10:15','10:00','07:30'] no tiene respaldo medido; las horas
-- dependen del schedule. Ver VisaClient / reschedule-logic.ts.
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "speculative_times" text[];
