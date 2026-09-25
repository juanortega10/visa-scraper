-- Registro de asistencia a la llamada con Erika.
-- `asistencia_host` es un tipo nuevo de recordatorio: el correo a Erika 20 min después.
-- La respuesta la guarda visa_frontend/src/app/api/asistencia en calcom_bookings.

ALTER TABLE call_reminders DROP CONSTRAINT IF EXISTS call_reminders_tipo_check;
ALTER TABLE call_reminders ADD CONSTRAINT call_reminders_tipo_check
  CHECK (tipo IN ('confirmacion','t24h','t2h','t10m','asistencia_host'));

ALTER TABLE calcom_bookings ADD COLUMN IF NOT EXISTS asistio boolean;
ALTER TABLE calcom_bookings ADD COLUMN IF NOT EXISTS asistio_marcado_at timestamptz;
