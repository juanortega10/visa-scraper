/**
 * Despierta un bot atrapado en un backoff largo.
 *
 * `set-bot-active.ts` limpia `activeRunId`, y eso NO alcanza. Si quedo un run
 * DELAYED en Trigger.dev, el guard de `poll-visa.ts:233` lo detecta y aborta cada
 * run del cron en ~1,5 s:
 *
 *   "DEDUP FALLBACK — found DELAYED run, aborting this run"
 *
 * Resultado: el bot figura `active`, la cadena parece viva, y no pollea hasta que
 * vence el retraso. Caso real: bot 299 quedo dormido 8 h por un backoff de 480 min
 * mal escalado, y seguia dormido despues de arreglar el calculo.
 *
 * Este script cancela los runs DELAYED y limpia `activeRunId`, para que el proximo
 * cron arranque de verdad.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/wake-bot.ts 299            # dry-run
 *   npx tsx --env-file=.env scripts/wake-bot.ts 299 --commit
 *   npx tsx --env-file=.env scripts/wake-bot.ts 299 --commit --run run_abc123
 *
 * `--run` cancela un run concreto. Hace falta porque `runs.list({ tag })` no
 * siempre devuelve los runs DELAYED viejos; el id sale del journal del RPi:
 *   journalctl -u visa-trigger | grep '\[chain\] bot <id>: ABORTA por run DELAYED'
 */
import { runs } from '@trigger.dev/sdk/v3';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';

const BOT_ID = Number(process.argv[2]);
const COMMIT = process.argv.includes('--commit');
if (!BOT_ID) { console.log('Uso: wake-bot.ts <botId> [--commit]'); process.exit(1); }

const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) { console.log(`bot ${BOT_ID} no existe`); process.exit(1); }

console.log(`DESPERTAR bot ${BOT_ID} · ${bot.locale} · ${bot.status} · ${COMMIT ? '*** REAL ***' : 'DRY-RUN'}`);
console.log(`  activeRunId: ${bot.activeRunId ?? '(vacio)'}`);
console.log(`  activeCloudRunId: ${bot.activeCloudRunId ?? '(vacio)'}\n`);

const argOf = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const RUN_EXPLICITO = argOf('--run');

const dormidos: Array<{ id: string; status: string; delayedUntil?: string }> = [];
if (RUN_EXPLICITO) {
  try {
    const r = await runs.retrieve(RUN_EXPLICITO);
    dormidos.push({ id: r.id, status: r.status });
    console.log(`  run explicito ${r.id} esta en ${r.status}`);
  } catch (e) {
    console.log(`  no se pudo leer ${RUN_EXPLICITO}: ${(e as Error).message}`);
    dormidos.push({ id: RUN_EXPLICITO, status: 'DESCONOCIDO' });
  }
}
try {
  const page = await runs.list({ tag: [`bot:${BOT_ID}`], limit: 50 });
  for (const r of page.data) {
    if (['DELAYED', 'QUEUED', 'DEQUEUED'].includes(r.status) && !dormidos.some((d) => d.id === r.id)) {
      dormidos.push({ id: r.id, status: r.status, delayedUntil: (r as { delayedUntil?: string }).delayedUntil });
    }
  }
} catch (e) {
  console.log(`no se pudo listar runs: ${(e as Error).message}`);
  console.log('(revisa TRIGGER_SECRET_KEY; en el RPi corre con el .env del proyecto)');
}

if (dormidos.length === 0) {
  console.log('No hay runs DELAYED ni encolados. La cadena no esta bloqueada por esto.');
} else {
  console.log(`${dormidos.length} run(s) que bloquean el arranque:`);
  for (const r of dormidos) {
    console.log(`  ${r.id}  ${r.status}${r.delayedUntil ? `  hasta ${r.delayedUntil}` : ''}`);
  }
  if (COMMIT) {
    for (const r of dormidos) {
      try { await runs.cancel(r.id); console.log(`  cancelado ${r.id}`); }
      catch (e) { console.log(`  FALLO al cancelar ${r.id}: ${(e as Error).message}`); }
    }
  }
}

if (COMMIT) {
  await db.update(bots).set({
    status: 'active', activeRunId: null, activeCloudRunId: null, updatedAt: new Date(),
  }).where(eq(bots.id, BOT_ID));
  console.log(`\nbot ${BOT_ID} en active, sin activeRunId. El cron lo toma en menos de 2 min.`);
} else {
  console.log('\nDRY-RUN. Con --commit cancela los runs y limpia activeRunId.');
}
process.exit(0);
