/**
 * Overnight monitoring for Bot 7 (es-pe).
 * Runs checks every 30min, outputs stats.
 * Usage: npx tsx --env-file=.env scripts/monitor-bot7.ts
 */

const API = 'https://visa.homiapp.xyz/api';
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30min
const NUM_CHECKS = 10;

function bogotaTime(): string {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
}

interface Poll {
  id: number;
  status: string;
  earliestDate: string | null;
  responseTimeMs: number;
  publicIp: string | null;
  rescheduleResult: string | null;
  createdAt: string;
}

async function check(checkNum: number) {
  const time = bogotaTime();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`CHECK #${checkNum} — ${time} Bogota`);
  console.log('='.repeat(50));

  // Bot status
  const bot = await fetch(`${API}/bots/7`).then(r => r.json());
  console.log(`\nBot 7: status=${bot.status}, rescheduleCount=${bot.rescheduleCount}, consular=${bot.currentConsularDate}`);

  if (bot.rescheduleCount > 0) {
    console.log('🎉 BOT 7 RESCHEDULED! Check reschedule logs.');
  }

  // Last 60 polls
  const polls: Poll[] = await fetch(`${API}/bots/7/logs/polls?limit=60`).then(r => r.json());

  // Status breakdown
  const statusCounts: Record<string, number> = {};
  for (const p of polls) {
    statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
  }
  console.log(`\nStatus (last ${polls.length} polls):`);
  for (const [s, c] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    const pct = ((c / polls.length) * 100).toFixed(0);
    console.log(`  ${s}: ${c} (${pct}%)`);
  }

  // IP breakdown
  const ipStats: Record<string, { total: number; blocked: number; okMs: number[] }> = {};
  for (const p of polls) {
    const ip = p.publicIp || 'unknown';
    if (!ipStats[ip]) ipStats[ip] = { total: 0, blocked: 0, okMs: [] };
    ipStats[ip].total++;
    if (p.status === 'tcp_blocked') {
      ipStats[ip].blocked++;
    } else {
      ipStats[ip].okMs.push(p.responseTimeMs);
    }
  }
  console.log(`\nIP breakdown:`);
  const sorted = Object.entries(ipStats).sort((a, b) => b[1].total - a[1].total);
  for (const [ip, s] of sorted) {
    const okPct = (((s.total - s.blocked) / s.total) * 100).toFixed(0);
    const avgMs = s.okMs.length > 0 ? Math.round(s.okMs.reduce((a, b) => a + b, 0) / s.okMs.length) : 0;
    console.log(`  ${ip}: ${s.total - s.blocked}/${s.total} ok (${okPct}%) avgMs=${avgMs || 'N/A'}`);
  }

  // Flash dates
  const flashes = polls.filter(p => p.earliestDate !== null);
  if (flashes.length > 0) {
    console.log(`\n⚡ FLASH DATES DETECTED (${flashes.length}):`);
    for (const f of flashes) {
      console.log(`  ${f.earliestDate} at ${f.createdAt} (${f.responseTimeMs}ms) reschedule=${f.rescheduleResult || 'none'}`);
    }
  } else {
    console.log(`\nNo flash dates in last ${polls.length} polls.`);
  }

  // Latest 3
  console.log(`\nLatest 3:`);
  for (const p of polls.slice(0, 3)) {
    console.log(`  [${p.createdAt}] ${p.status} ip=${p.publicIp} ${p.responseTimeMs}ms${p.earliestDate ? ` earliest=${p.earliestDate}` : ''}`);
  }
}

async function main() {
  console.log(`Bot 7 overnight monitor started at ${bogotaTime()} Bogota`);
  console.log(`Will run ${NUM_CHECKS} checks every 30min`);

  for (let i = 1; i <= NUM_CHECKS; i++) {
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
    try {
      await check(i);
    } catch (err) {
      console.error(`Check #${i} failed:`, err);
    }
  }

  console.log(`\nMonitoring complete at ${bogotaTime()} Bogota`);
}

main();
