-- Un texto libre que Meta rechaza DESPUÉS de aceptarlo (131047: ventana de 24 h cerrada) se
-- reenvía una vez por plantilla. Esta columna marca ese reintento y evita un segundo.
ALTER TABLE call_reminders ADD COLUMN IF NOT EXISTS forzar_plantilla boolean NOT NULL DEFAULT false;
