-- Recordatorios de la llamada con Erika. Fuente de verdad del sistema: cada fila es un envío
-- con su hora exacta. El barredor la llena desde calcom_bookings y el run diferido la ejecuta.
--
-- Estados: pendiente -> enviando -> enviado | saltado | fallido
-- El paso a 'enviando' es el claim: solo un proceso lo gana, así no hay dobles envíos.

CREATE TABLE IF NOT EXISTS call_reminders (
  id           bigserial PRIMARY KEY,
  booking_id   text        NOT NULL,
  tipo         text        NOT NULL CHECK (tipo IN ('confirmacion','t24h','t2h','t10m')),
  canal        text        NOT NULL CHECK (canal IN ('whatsapp','email')),
  send_at      timestamptz NOT NULL,
  starts_at    timestamptz NOT NULL,
  status       text        NOT NULL DEFAULT 'pendiente'
                           CHECK (status IN ('pendiente','enviando','enviado','saltado','fallido')),
  dest_email   text,
  dest_phone   text,
  dest_bsuid   text,
  nombre       text,
  meet_url     text,
  es_prueba    boolean     NOT NULL DEFAULT false,
  run_id       text,
  intentos     int         NOT NULL DEFAULT 0,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  -- sent_at - send_at en milisegundos: la medida de precisión del sistema.
  lag_ms       int,
  via          text,
  external_id  text,
  motivo       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, tipo, canal)
);

CREATE INDEX IF NOT EXISTS idx_call_reminders_pendientes
  ON call_reminders (send_at) WHERE status = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_call_reminders_booking ON call_reminders (booking_id);
