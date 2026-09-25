-- Estado de entrega de cada WhatsApp de recordatorio. `status = enviado` solo dice que Kapso
-- aceptó el mensaje; Meta puede rebotarlo después y eso solo se ve en el status del mensaje.
ALTER TABLE call_reminders ADD COLUMN IF NOT EXISTS entrega text;
ALTER TABLE call_reminders ADD COLUMN IF NOT EXISTS entrega_error text;
ALTER TABLE call_reminders ADD COLUMN IF NOT EXISTS entrega_revisada_at timestamptz;
