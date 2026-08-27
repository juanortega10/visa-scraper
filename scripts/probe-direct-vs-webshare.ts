/**
 * PRUEBA EN VIVO de dos suposiciones que hoy estan sin verificar:
 *
 *   A) "La IP directa del RPi esta bloqueada para paginas HTML."
 *   B) "El login no funciona por webshare."
 *
 * Metodo: se hace UN login, y luego se pide la MISMA pagina HTML
 * (`/schedule/{id}/appointment`, la que usa `refreshTokens()`) dos veces:
 * una por la ruta directa y otra por webshare. Se mide y se compara.
 *
 * Seguridad: solo peticiones GET. Cero POST. Cero escrituras a la base de datos.
 * No cambia ninguna cita. No consume cuota de reagendamiento.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/probe-direct-vs-webshare.ts --bot 299
 *   npx tsx --env-file=.env scripts/probe-direct-vs-webshare.ts --bot 299 --repeticiones 3
 */
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { loginWithFallback } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';

const argOf = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const BOT_ID = Number(argOf('--bot') ?? 299);
const REPS = Number(argOf('--repeticiones') ?? 2);

const ms = (n: number) => `${n.toString().padStart(6)} ms`;
const line = (t: string) => console.log(`\n${'─'.repeat(64)}\n${t}\n${'─'.repeat(64)}`);

const [row] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!row) { console.log(`bot ${BOT_ID} no existe`); process.exit(1); }

console.log(`PRUEBA EN VIVO · bot ${BOT_ID} · ${row.locale} · proxy configurado: ${row.proxyProvider}`);
console.log(`host: ${os.hostname()}`);
console.log('solo GET. sin POST. sin escrituras.');

// ── B) Login: que ruta funciona ──────────────────────────────────────
line('B) LOGIN · que ruta conecta de verdad');
const tLogin = Date.now();
const { result: login, via } = await loginWithFallback({
  email: decrypt(row.visaEmail as string),
  password: decrypt(row.visaPassword as string),
  scheduleId: String(row.scheduleId),
  applicantIds: (row.applicantIds ?? []) as string[],
  locale: row.locale ?? 'es-co',
});
const loginMs = Date.now() - tLogin;
console.log(`  ruta que gano: ${via}`);
console.log(`  duracion:      ${ms(loginMs)}`);
console.log(`  cookie:        ${login.cookie ? `si (${login.cookie.length} chars)` : 'NO'}`);
console.log(`  csrfToken:     ${login.csrfToken ? `si (${login.csrfToken.length})` : 'NO'}`);
console.log(`  authenticity:  ${login.authenticityToken ? `si (${login.authenticityToken.length})` : 'NO'}`);

function build(postProvider: 'direct' | 'webshare') {
  return new VisaClient(
    { cookie: login.cookie, csrfToken: login.csrfToken ?? '', authenticityToken: login.authenticityToken ?? '' },
    {
      scheduleId: String(row!.scheduleId),
      applicantIds: (row!.applicantIds ?? []) as string[],
      consularFacilityId: String(row!.consularFacilityId ?? '25'),
      ascFacilityId: String(row!.ascFacilityId ?? '26'),
      proxyProvider: row!.proxyProvider,
      postProvider,
      proxyUrls: row!.proxyUrls as string[] | null,
      locale: row!.locale ?? 'es-co',
      userId: String(row!.userId),
    },
  );
}

// ── A) La pagina HTML por cada ruta ──────────────────────────────────
line('A) PAGINA HTML (la de refreshTokens) · directo contra webshare');
console.log(`${'ruta'.padEnd(10)}${'#'.padEnd(4)}${'resultado'.padEnd(12)}duracion      tokens`);

const results: Record<string, number[]> = { direct: [], webshare: [] };

for (const provider of ['direct', 'webshare'] as const) {
  for (let i = 1; i <= REPS; i++) {
    const client = build(provider);
    const t = Date.now();
    let outcome = 'OK';
    let tokens = '';
    try {
      await client.refreshTokens();
      const a = client.getSession();
      tokens = a.authenticityToken ? `authenticity ${a.authenticityToken.length} chars` : 'sin tokens';
    } catch (e) {
      outcome = 'FALLO';
      tokens = (e as Error).message.slice(0, 46);
    }
    const d = Date.now() - t;
    results[provider]!.push(d);
    console.log(`${provider.padEnd(10)}${String(i).padEnd(4)}${outcome.padEnd(12)}${ms(d)}   ${tokens}`);
  }
}

// ── Veredicto ────────────────────────────────────────────────────────
line('VEREDICTO');
const med = (xs: number[]) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0;
const dDirect = med(results.direct!);
const dWebshare = med(results.webshare!);
console.log(`  directo   mediana ${ms(dDirect)}`);
console.log(`  webshare  mediana ${ms(dWebshare)}`);
if (dDirect >= 11500) {
  console.log(`\n  A) CONFIRMADO: la ruta directa agota el headersTimeout de 12000 ms.`);
} else if (dDirect > dWebshare * 1.5) {
  console.log(`\n  A) PARCIAL: la ruta directa es ${(dDirect / Math.max(dWebshare,1)).toFixed(1)}x mas lenta, sin llegar al timeout.`);
} else {
  console.log(`\n  A) REFUTADO: la ruta directa responde bien. La suposicion estaba mal.`);
}
console.log(`  B) el login uso la ruta "${via}" en ${loginMs} ms.`);
process.exit(0);
