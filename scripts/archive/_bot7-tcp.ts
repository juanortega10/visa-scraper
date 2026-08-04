import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { pollLogs } from '../src/db/schema.js';
import { eq, gte } from 'drizzle-orm';

const db = drizzle(neon(process.env.DATABASE_URL!));

// Last 30 days of polls for bot 7
const since = new Date(Date.now() - 30 * 24 * 3600000);
const rows = await db.select({
  createdAt: pollLogs.createdAt,
  status: pollLogs.status,
}).from(pollLogs)
  .where(gte(pollLogs.createdAt, since))
  .orderBy(pollLogs.createdAt);

// Filter bot 7 only (botId not in select scope — re-query)
const all = await db.select({
  createdAt: pollLogs.createdAt,
  status: pollLogs.status,
}).from(pollLogs)
  .where(eq(pollLogs.botId, 7))
  .orderBy(pollLogs.createdAt);

const LIMA = -5;

// ── 1. TCP block episodes: consecutive tcp_blocked runs ──
type Episode = { start: Date; end: Date; count: number; preceedingOkCount: number; preceedingOkMinutes: number };
const episodes: Episode[] = [];
let inBlock = false;
let blockStart: Date | null = null;
let blockCount = 0;
let prevOkCount = 0;
let prevOkStart: Date | null = null;
let prevOkMs = 0;

for (let i = 0; i < all.length; i++) {
  const r = all[i];
  const isTcp = r.status === 'tcp_blocked';

  if (!inBlock && isTcp) {
    inBlock = true;
    blockStart = new Date(r.createdAt);
    blockCount = 1;
  } else if (inBlock && isTcp) {
    blockCount++;
  } else if (inBlock && !isTcp) {
    // block ended
    const okMinutes = prevOkStart ? (blockStart!.getTime() - prevOkStart.getTime()) / 60000 : 0;
    episodes.push({ start: blockStart!, end: new Date(all[i-1].createdAt), count: blockCount, preceedingOkCount: prevOkCount, preceedingOkMinutes: Math.round(okMinutes) });
    inBlock = false;
    prevOkStart = new Date(r.createdAt);
    prevOkCount = 1;
    prevOkMs = 0;
  } else if (!inBlock && !isTcp) {
    if (!prevOkStart) prevOkStart = new Date(r.createdAt);
    prevOkCount++;
  }
}

// ── 2. Group by hour-bucket: polls and tcp rate ──
const hourBuckets: Record<string, { total: number; tcp: number }> = {};
for (const r of all) {
  const lima = new Date(new Date(r.createdAt).getTime() + LIMA * 3600000);
  const key = `${lima.toISOString().slice(0,13)}`;
  if (!hourBuckets[key]) hourBuckets[key] = { total: 0, tcp: 0 };
  hourBuckets[key].total++;
  if (r.status === 'tcp_blocked') hourBuckets[key].tcp++;
}

// ── 3. Find: how many polls before first tcp in a run ──
console.log(`\nTotal polls bot 7: ${all.length}`);
console.log(`TCP block episodes (consecutive blocks): ${episodes.length}`);

console.log('\n── Block episodes (last 30d, >5 blocked polls) ──');
console.log('Start (Lima)      | blocks | prev_ok_polls | prev_ok_min | block_rate');
console.log('------------------|--------|---------------|-------------|----------');
for (const e of episodes) {
  if (e.count < 5) continue;
  const limaStart = new Date(e.start.getTime() + LIMA * 3600000).toISOString().replace('T',' ').slice(0,16);
  const limaEnd   = new Date(e.end.getTime() + LIMA * 3600000).toISOString().replace('T',' ').slice(0,16);
  const durationMin = Math.round((e.end.getTime() - e.start.getTime()) / 60000);
  console.log(`${limaStart} | ${String(e.count).padStart(6)} | ${String(e.preceedingOkCount).padStart(13)} | ${String(e.preceedingOkMinutes).padStart(11)} | ${durationMin}min`);
}

// ── 4. Rolling window: polls per hour → tcp rate ──
// Find hours with high poll rate and correlate with tcp rate
console.log('\n── Polls/hora vs TCP% (últimas 2 semanas, solo horas con >20 polls) ──');
console.log('Hora Lima         | polls | tcp  | tcp%');
console.log('------------------|-------|------|-----');
const sortedKeys = Object.keys(hourBuckets).sort();
const recentKeys = sortedKeys.filter(k => k >= new Date(Date.now() - 14*24*3600000 + LIMA*3600000).toISOString().slice(0,13));
for (const k of recentKeys) {
  const b = hourBuckets[k];
  if (b.total < 20) continue;
  const tcpPct = Math.round(b.tcp / b.total * 100);
  const bar = tcpPct > 0 ? '▓'.repeat(Math.ceil(tcpPct/5)) : '░';
  console.log(`${k.replace('T',' ')} | ${String(b.total).padStart(5)} | ${String(b.tcp).padStart(4)} | ${String(tcpPct).padStart(3)}% ${bar}`);
}

// ── 5. Recovery time analysis ──
console.log('\n── Duración de bloqueos (episodios > 5 polls) ──');
const durations: number[] = [];
for (const e of episodes) {
  if (e.count < 5) continue;
  const min = Math.round((e.end.getTime() - e.start.getTime()) / 60000);
  durations.push(min);
}
durations.sort((a,b) => a-b);
if (durations.length) {
  const median = durations[Math.floor(durations.length/2)];
  const p90 = durations[Math.floor(durations.length*0.9)];
  console.log(`n=${durations.length}  min=${durations[0]}m  median=${median}m  p90=${p90}m  max=${durations[durations.length-1]}m`);
  console.log('Distribución:', durations.join(', '), 'min');
}
