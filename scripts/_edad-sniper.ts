/** Minutos desde el ultimo escaneo del sniper del 299. Lo usa vigilar-sniper-299.sh. */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
const r = await db.execute<any>(sql`
  SELECT floor(extract(epoch from (now() - max(scanned_at))) / 60) AS min
  FROM sniper_scans WHERE scan_key = 'peru-299'`);
console.log(String(r.rows[0]?.min ?? ''));
process.exit(0);
