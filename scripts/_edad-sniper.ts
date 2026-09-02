/**
 * Estado del sniper del 299 en una linea: `<minutos> <fase>`.
 *
 * Lo usa `vigilar-sniper-299.sh`. Devuelve la FASE ademas de la edad porque sin ella el
 * vigilante confunde dos cosas distintas:
 *
 *   fase `ruta_cerrada`  el sniper esta VIVO y la ruta del portal esta cerrada. Se calla
 *                        a proposito, y cada vez mas: `minutosEntreDisparos` crece con los
 *                        errores seguidos. Eso no es una falla del sniper.
 *   cualquier otra       si la edad crece, el sniper si dejo de trabajar.
 *
 * El 2026-09-02 el vigilante mando "sniper-parado" dos veces con el servicio activo y
 * pollando: la primera por el backoff de la ruta, la segunda por el backoff del token.
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';

const r = await db.execute<{ min: string | null; fase: string | null }>(sql`
  SELECT floor(extract(epoch from (now() - max(scanned_at))) / 60) AS min,
         (SELECT phase FROM sniper_scans WHERE scan_key = 'peru-299'
           ORDER BY scanned_at DESC LIMIT 1) AS fase
  FROM sniper_scans WHERE scan_key = 'peru-299'`);
const f = r.rows[0];
console.log(`${f?.min ?? ''} ${f?.fase ?? ''}`.trim());
process.exit(0);
