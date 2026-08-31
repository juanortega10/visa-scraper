-- Sistema de medicion (31 ago 2026)
--
-- Tres enteros en filas que ya existen, mas una tabla de resumen por hora.
-- No agrega ni una fila por poll: eso fue lo que inflo auth_logs a 434 MB.

-- El numero que decide una carrera por un cupo. `duration_ms` no sirve porque
-- mezcla los fetch previos, el POST y la verificacion posterior.
ALTER TABLE reschedule_logs ADD COLUMN IF NOT EXISTS ms_to_post integer;

-- Cuantos horarios ofrecio el portal. 0 = fecha fantasma, >0 = nos ganaron.
ALTER TABLE reschedule_logs ADD COLUMN IF NOT EXISTS times_seen integer;

-- Milisegundos desde el poll anterior de ese bot. Antes se calculaba con una
-- funcion de ventana sobre toda la tabla en cada consulta.
ALTER TABLE poll_logs ADD COLUMN IF NOT EXISTS blind_ms integer;

-- Resumen por bot y hora. Reemplaza los escaneos del panel sobre poll_logs,
-- que costaron 77,73 USD de compute en agosto.
CREATE TABLE IF NOT EXISTS bot_hourly (
  id                  serial PRIMARY KEY,
  bot_id              integer NOT NULL,
  hour                timestamp NOT NULL,
  poll_rows           integer NOT NULL DEFAULT 0,
  polls               integer NOT NULL DEFAULT 0,
  blind_ms            integer NOT NULL DEFAULT 0,
  blocked             integer NOT NULL DEFAULT 0,
  errors              integer NOT NULL DEFAULT 0,
  relogins            integer NOT NULL DEFAULT 0,
  sightings           integer NOT NULL DEFAULT 0,
  missed_while_blind  integer NOT NULL DEFAULT 0,
  attempts            integer NOT NULL DEFAULT 0,
  wins                integer NOT NULL DEFAULT 0,
  p50_ms_to_post      integer,
  phantom_dates       integer NOT NULL DEFAULT 0,
  created_at          timestamp NOT NULL DEFAULT now()
);

-- El rollup hace upsert contra esta llave: correrlo dos veces sobre la misma
-- hora no duplica filas ni suma de mas.
CREATE UNIQUE INDEX IF NOT EXISTS bot_hourly_bot_hour_idx ON bot_hourly (bot_id, hour);
CREATE INDEX IF NOT EXISTS bot_hourly_hour_idx ON bot_hourly (hour);
