/**
 * QUE hora devuelve `times.json`, no cuantas.
 *
 * Fuente: `sniper_scans` con `phase='ensayo'`. Es la UNICA fuente limpia que existe.
 * El ensayo mide y nunca postea, entonces no puede escribir la constante del fallback
 * dentro del dato. `reschedule_logs.detail` SI esta contaminada: las 354 apariciones
 * del trio 10:15/10:00/07:30 son `SPECULATIVE_TIMES` de `reschedule-logic.ts`, no
 * lecturas del portal. Ver [[horas-especulativas-contaminadas]].
 *
 * Da DOS cuentas por hora, y hay que leer las dos:
 *
 *   filas    cuantas muestras la vieron. Como el ensayo corre cada 10 min, esto pesa
 *            TIEMPO: una hora que dura 2 h suma el doble que una que dura 1 h.
 *   bloques  cuantas veces esa hora APARECIO como tramo nuevo. Esto pesa EVENTOS.
 *
 * Contar solo filas sobreestima las horas de vida larga. Contar solo bloques trata un
 * tramo de 10 min igual que uno de 2 h. Para adivinar una hora manda `filas`, porque
 * la pregunta es "si disparo ahora, cual es la hora vigente".
 *
 *   npx tsx --env-file=.env scripts/analyze-horas-ensayo.ts
 *   npx tsx --env-file=.env scripts/analyze-horas-ensayo.ts --clave peru-299
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';

const argS = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const CLAVE = argS('clave', 'peru-299');

const pad = (v: unknown, n: number) => String(v ?? '').padStart(n);
const padr = (v: unknown, n: number) => String(v ?? '').padEnd(n);
/**
 * `db.execute` crudo devuelve el timestamp como texto SIN zona. Postgres lo guarda en
 * UTC, entonces hay que pegarle la Z a mano: `new Date('2026-08-31 17:23')` sin Z lo
 * lee como hora LOCAL y en Bogota se corre 5 h. Ver la trampa en CLAUDE.md.
 */
const aFecha = (v: unknown): Date =>
  v instanceof Date ? v : new Date(`${String(v).replace(' ', 'T')}Z`);
const bogota = (v: unknown) =>
  new Date(aFecha(v).getTime() - 5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');

const filas = await db.execute(sql`
  SELECT scanned_at, payload->'horas' horas, payload->>'fechaEnsayo' fecha,
         (payload->>'diasHastaFecha')::int dias
  FROM sniper_scans
  WHERE scan_key = ${CLAVE} AND phase = 'ensayo' AND payload->'horas' IS NOT NULL
  ORDER BY scanned_at
`);

type Fila = { scanned_at: unknown; horas: string[] | null; fecha: string | null; dias: number | null };
const muestras = (filas.rows as unknown as Fila[])
  .map((f) => ({ ...f, scanned_at: aFecha(f.scanned_at), horas: (f.horas ?? []).filter(Boolean) }))
  .filter((f) => f.horas.length > 0);

if (muestras.length === 0) {
  console.log(`Sin muestras de ensayo para '${CLAVE}'. El sniper escribe una cada 10 min.`);
  process.exit(0);
}

// ── Cuantas horas por respuesta ──────────────────────────────────────────────
const porCantidad = new Map<number, number>();
for (const m of muestras) porCantidad.set(m.horas.length, (porCantidad.get(m.horas.length) ?? 0) + 1);

// ── Filas y bloques por hora ─────────────────────────────────────────────────
const conteo = new Map<string, { filas: number; bloques: number; primera: Date; ultima: Date }>();
let anterior: string | null = null;
for (const m of muestras) {
  // Una respuesta con varias horas cuenta para cada una. Hoy siempre trae una.
  for (const h of m.horas) {
    const c = conteo.get(h) ?? { filas: 0, bloques: 0, primera: m.scanned_at, ultima: m.scanned_at };
    c.filas += 1;
    c.ultima = m.scanned_at;
    conteo.set(h, c);
  }
  // Un bloque nuevo empieza cuando la respuesta cambia respecto de la muestra previa.
  const clave = m.horas.join(',');
  if (clave !== anterior) for (const h of m.horas) conteo.get(h)!.bloques += 1;
  anterior = clave;
}

const total = muestras.length;
const orden = [...conteo.entries()].sort((a, b) => b[1].filas - a[1].filas);
const maxFilas = orden[0]![1].filas;

console.log(`\nHORAS QUE DEVOLVIO times.json · clave '${CLAVE}' · ${total} muestras de ensayo`);
const fechas = new Set(muestras.map((m) => m.fecha));
const dias = muestras.map((m) => m.dias).filter((d): d is number => d !== null);
console.log(`Fecha(s) preguntada(s): ${[...fechas].join(', ')} · a ${Math.min(...dias)}-${Math.max(...dias)} dias`);
console.log(`Ventana: ${bogota(muestras[0]!.scanned_at)} a ${bogota(muestras.at(-1)!.scanned_at)} (Bogota)\n`);

console.log(`${padr('hora', 7)}${pad('filas', 6)}${pad('%', 6)}  ${padr('', 32)}${pad('bloques', 8)}  vigente desde -> hasta (Bogota)`);
console.log('─'.repeat(112));
let acumulado = 0;
for (const [hora, c] of orden) {
  acumulado += c.filas;
  const barra = '█'.repeat(Math.max(1, Math.round((c.filas / maxFilas) * 30)));
  console.log(
    `${padr(hora, 7)}${pad(c.filas, 6)}${pad(`${((100 * c.filas) / total).toFixed(0)}%`, 6)}  ${padr(barra, 32)}` +
    `${pad(c.bloques, 8)}  ${bogota(c.primera)} -> ${bogota(c.ultima)}`,
  );
}

console.log('\nCOBERTURA ACUMULADA si se adivinan las N mas vistas:');
let suma = 0;
for (let i = 0; i < Math.min(5, orden.length); i++) {
  suma += orden[i]![1].filas;
  const lista = orden.slice(0, i + 1).map(([h]) => h).join(', ');
  console.log(`  ${i + 1} hora(s)  ${pad(`${((100 * suma) / total).toFixed(0)}%`, 5)}   [${lista}]`);
}

console.log('\nCUANTAS HORAS TRAE CADA RESPUESTA:');
for (const [n, c] of [...porCantidad.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${n} hora(s): ${c} respuestas (${((100 * c) / total).toFixed(0)}%)`);
}

// ── La hora se mueve, o se queda quieta ──────────────────────────────────────
console.log('\nLINEA DE TIEMPO (un renglon por cambio):');
let previo: string | null = null;
let desde: Date | null = null;
const tramos: Array<{ hora: string; desde: Date; hasta: Date; muestras: number }> = [];
let n = 0;
for (const m of muestras) {
  const clave = m.horas.join(',');
  if (clave !== previo) {
    if (previo !== null) tramos.push({ hora: previo, desde: desde!, hasta: m.scanned_at, muestras: n });
    previo = clave;
    desde = m.scanned_at;
    n = 0;
  }
  n += 1;
}
if (previo !== null) tramos.push({ hora: previo, desde: desde!, hasta: muestras.at(-1)!.scanned_at, muestras: n });

for (const t of tramos) {
  const min = Math.round((t.hasta.getTime() - t.desde.getTime()) / 60_000);
  console.log(`  ${bogota(t.desde)} -> ${bogota(t.hasta)}  ${padr(t.hora, 7)} ${pad(min, 5)} min  ${t.muestras} muestras`);
}

const duraciones = tramos.filter((t) => t.muestras > 1).map((t) => (t.hasta.getTime() - t.desde.getTime()) / 60_000);
if (duraciones.length) {
  duraciones.sort((a, b) => a - b);
  const mediana = duraciones[Math.floor(duraciones.length / 2)]!;
  console.log(`\n  ${tramos.length} tramos · duracion mediana ${Math.round(mediana)} min (solo tramos con mas de 1 muestra)`);
  console.log('  CUIDADO: un tramo que cruza un corte del sniper mide el hueco, no la duracion real.');
}

// ── Por FECHA. Es la vista que decide, y casi siempre desmiente al histograma ──
//
// El histograma de arriba cuenta MUESTRAS, y el ensayo corre cada 10 min. Entonces
// mide cuanto TIEMPO miramos una fecha, no cuantas fechas distintas vimos. Vigilar una
// sola fecha 2 h da 12 filas y parece una montana de evidencia; son UN dato.
//
// Para adivinar la hora de un cupo que ACABA de aparecer, la unica cifra util es la
// PRIMERA hora que se vio en cada fecha. Todo lo que viene despues es la deriva de una
// fecha que ya estabamos mirando, y ese caso no se parece al del cupo nuevo.
const porFecha = new Map<string, Array<{ hora: string; en: Date }>>();
for (const m of muestras) {
  if (!m.fecha) continue;
  const lista = porFecha.get(m.fecha) ?? [];
  if (lista.at(-1)?.hora !== m.horas.join(',')) lista.push({ hora: m.horas.join(','), en: m.scanned_at });
  porFecha.set(m.fecha, lista);
}
console.log(`\nPOR FECHA · ${porFecha.size} fechas independientes (contra ${total} muestras)`);
console.log('─'.repeat(112));
let subidas = 0;
let bajadas = 0;
for (const [fecha, lista] of [...porFecha.entries()].sort()) {
  const cadena = lista.map((x) => `${x.hora} (${bogota(x.en).slice(11)})`).join('  ->  ');
  console.log(`  ${fecha}  ${cadena}`);
  for (let i = 1; i < lista.length; i++) {
    if (lista[i]!.hora > lista[i - 1]!.hora) subidas += 1;
    else if (lista[i]!.hora < lista[i - 1]!.hora) bajadas += 1;
  }
}
console.log(`\n  Dentro de una misma fecha la hora subio ${subidas} veces y bajo ${bajadas}.`);

const primeras = [...porFecha.values()].map((l) => l[0]!.hora);
const cuentaPrimeras = new Map<string, number>();
for (const h of primeras) cuentaPrimeras.set(h, (cuentaPrimeras.get(h) ?? 0) + 1);
console.log('\n  PRIMERA hora vista en cada fecha (esto es lo que hay que adivinar):');
for (const [h, n2] of [...cuentaPrimeras.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${padr(h, 12)} ${n2} de ${porFecha.size} fechas`);
}
if (porFecha.size < 20) {
  console.log(`\n  MUESTRA INSUFICIENTE. ${porFecha.size} fechas no alcanzan para elegir horas especulativas.`);
  console.log('  El histograma de arriba pesa tiempo de observacion, no fechas. No lo uses para decidir.');
}

process.exit(0);
