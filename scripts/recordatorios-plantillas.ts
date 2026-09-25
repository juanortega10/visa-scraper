/**
 * Crea en Meta las 4 plantillas UTILITY de los recordatorios, con el texto EXACTO de
 * `CUERPOS` (el mismo que usa el texto libre).
 *
 *   npx tsx scripts/recordatorios-plantillas.ts           # estado de cada una
 *   npx tsx scripts/recordatorios-plantillas.ts --crear   # crea las que faltan
 *
 * Cuando Meta las apruebe, la línea para la RPi sale al final:
 *   RECORDATORIOS_PLANTILLAS_OK=...
 */
import 'dotenv/config';
import { CUERPOS, PLANTILLAS } from '../src/services/recordatorios/mensajes.js';
import type { TipoRecordatorio } from '../src/services/recordatorios/plan.js';

const WABA = '928186266546871';
const KEY = process.env.KAPSO_API_KEY;
if (!KEY) throw new Error('falta KAPSO_API_KEY');
const BASE = `https://api.kapso.ai/meta/whatsapp/v24.0/${WABA}/message_templates`;
const CREAR = process.argv.includes('--crear');

const EJEMPLOS: Record<TipoRecordatorio, string[]> = {
  confirmacion: ['Laura', 'mañana jueves 2 de octubre a las 3:00 p. m.', 'https://meet.google.com/abc-defg-hij'],
  t24h: ['Laura', 'mañana jueves 2 de octubre a las 3:00 p. m.', 'https://meet.google.com/abc-defg-hij'],
  t2h: ['Laura', 'hoy a las 3:00 p. m.', 'https://meet.google.com/abc-defg-hij'],
  t10m: ['Laura', 'https://meet.google.com/abc-defg-hij'],
};

const r = await fetch(`${BASE}?limit=200`, { headers: { 'X-API-Key': KEY } });
const j: any = await r.json();
if (!Array.isArray(j.data)) throw new Error('Meta no devolvió la lista: ' + JSON.stringify(j).slice(0, 300));
const vivas = new Map<string, any>(j.data.map((t: any) => [t.name, t]));

const aprobadas: string[] = [];
for (const tipo of Object.keys(PLANTILLAS) as TipoRecordatorio[]) {
  const name = PLANTILLAS[tipo];
  const ya = vivas.get(name);
  if (ya) {
    console.log(`  ${name.padEnd(36)} ${ya.status} (${ya.category})`);
    if (ya.status === 'APPROVED' && ya.category === 'UTILITY') aprobadas.push(name);
    continue;
  }
  if (!CREAR) { console.log(`  ${name.padEnd(36)} FALTA`); continue; }
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, language: 'es', category: 'UTILITY',
      components: [
        { type: 'BODY', text: CUERPOS[tipo], example: { body_text: [EJEMPLOS[tipo]] } },
        { type: 'FOOTER', text: 'Visagente' },
      ],
    }),
  });
  const out: any = await res.json().catch(() => ({}));
  console.log(`  ${name.padEnd(36)} ${res.ok && !out.error ? `creada: ${out.status || 'PENDING'}` : 'ERROR ' + JSON.stringify(out.error || out).slice(0, 200)}`);
  await new Promise((ok) => setTimeout(ok, 400));
}
console.log(`\nRECORDATORIOS_PLANTILLAS_OK=${aprobadas.join(',')}`);
