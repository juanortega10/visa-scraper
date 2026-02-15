/**
 * Test CAS days endpoint via direct + firecrawl to diagnose IP issues.
 * Usage: npx tsx scripts/test-cas.ts [--bot-id=6]
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { sessions, bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const a = args.find((a) => a.startsWith(`--${name}=`));
  return a ? a.split('=')[1]! : def;
};
const botId = parseInt(getArg('bot-id', '6'), 10);

async function main() {
  const [s] = await db.select().from(sessions).where(eq(sessions.botId, botId));
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!s || !bot) { console.log('No session/bot'); process.exit(1); }

  const cookie = decrypt(s.yatriCookie);
  const csrf = s.csrfToken!;
  const ageMin = Math.round((Date.now() - s.createdAt.getTime()) / 60000);
  console.log(`Session age: ${ageMin}min`);

  const scheduleId = bot.scheduleId;
  const baseUrl = `https://ais.usvisa-info.com/${bot.locale}/niv`;

  const headers: Record<string, string> = {
    'Cookie': `_yatri_session=${cookie}`,
    'X-CSRF-Token': csrf,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Referer': `${baseUrl}/schedule/${scheduleId}/appointment`,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  };

  // 1. Get consular days
  console.log('\n--- DIRECT: Consular days ---');
  const daysUrl = `${baseUrl}/schedule/${scheduleId}/appointment/days/25.json?appointments[expedite]=false`;
  const daysRes = await fetch(daysUrl, { headers, redirect: 'manual' });
  console.log(`Status: ${daysRes.status}`);
  if (daysRes.status !== 200) { console.log(await daysRes.text().then(t => t.slice(0, 300))); process.exit(1); }
  const days: Array<{ date: string }> = JSON.parse(await daysRes.text());
  console.log(`Total: ${days.length}, earliest: ${days[0]?.date}, top3: ${days.slice(0, 3).map(d => d.date).join(', ')}`);

  if (days.length === 0) { console.log('No consular days!'); process.exit(0); }

  // 2. Get consular times for first 3 dates, test CAS for each
  for (let i = 0; i < Math.min(days.length, 3); i++) {
    const d = days[i]!.date;
    const timesUrl = `${baseUrl}/schedule/${scheduleId}/appointment/times/25.json?date=${d}&appointments[expedite]=false`;
    const timesRes = await fetch(timesUrl, { headers, redirect: 'manual' });
    const timesData = await timesRes.json() as { available_times: string[] };
    const availTimes = timesData.available_times ?? [];
    console.log(`\n=== Date ${i + 1}: ${d} — ${availTimes.length} consular times: ${availTimes.join(', ')} ===`);

    if (availTimes.length === 0) continue;

    // Test CAS for first consular time via DIRECT
    const t = availTimes[0]!;
    const casUrl = `${baseUrl}/schedule/${scheduleId}/appointment/days/26.json?consulate_id=25&consulate_date=${d}&consulate_time=${t}&appointments[expedite]=false`;

    console.log(`  DIRECT CAS (${d} ${t}):`);
    const casRes = await fetch(casUrl, { headers, redirect: 'manual' });
    const casBody = await casRes.text();
    console.log(`    Status: ${casRes.status}, Body (200 chars): ${casBody.slice(0, 200)}`);

    // Test same CAS via FIRECRAWL
    const firecrawlKey = process.env.FIRECRAWL_API_KEY;
    if (firecrawlKey) {
      console.log(`  FIRECRAWL CAS (${d} ${t}):`);
      const fcRes = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${firecrawlKey}`,
        },
        body: JSON.stringify({
          url: casUrl,
          formats: ['rawHtml'],
          headers,
        }),
      });
      const fcBody = await fcRes.json() as any;
      const raw = fcBody.data?.rawHtml ?? fcBody.data?.html ?? JSON.stringify(fcBody).slice(0, 300);
      console.log(`    Firecrawl HTTP: ${fcRes.status}, Body (200 chars): ${raw.slice(0, 200)}`);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
