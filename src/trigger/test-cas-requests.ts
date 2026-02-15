import { task, logger } from '@trigger.dev/sdk/v3';
import { db } from '../db/client.js';
import { bots, sessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../services/encryption.js';
import { VisaClient, SessionExpiredError } from '../services/visa-client.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Test task: counts exact requests the CAS prefetch algorithm makes.
 * Logs per-probe dates and overlap analysis. No DB writes.
 * Deploy to prod → trigger via MCP to test from cloud IP.
 */
export const testCasRequestsTask = task({
  id: 'test-cas-requests',
  machine: { preset: 'micro' },
  maxDuration: 120,
  retry: { maxAttempts: 0 },

  run: async (payload: { botId: number; windowDays?: number }) => {
    const { botId, windowDays: WINDOW_DAYS = 30 } = payload;
    const PROBE_INTERVAL = 5;
    const MAX_PROBES = 8;
    const MAX_REQUESTS = 45;

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    const [session] = await db.select().from(sessions).where(eq(sessions.botId, botId));
    if (!bot || !session) { logger.error('No bot/session'); return; }

    const cookie = decrypt(session.yatriCookie);
    const ageMin = Math.round((Date.now() - session.createdAt.getTime()) / 60000);
    logger.info('Setup', { botId, sessionAgeMin: ageMin, windowDays: WINDOW_DAYS });

    // Log public IP
    try {
      const ipRes = await fetch('https://api.ipify.org?format=json');
      const { ip } = await ipRes.json() as { ip: string };
      logger.info('Public IP', { ip });
    } catch { logger.warn('Could not get public IP'); }

    const client = new VisaClient(
      { cookie, csrfToken: session.csrfToken ?? '', authenticityToken: session.authenticityToken ?? '' },
      {
        scheduleId: bot.scheduleId, applicantIds: bot.applicantIds,
        consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId,
        proxyProvider: 'direct', userId: bot.userId, locale: bot.locale,
      },
    );

    let totalRequests = 0;
    const globalStart = Date.now();
    const byEndpoint: Record<string, number> = {};

    function count(endpoint: string) {
      totalRequests++;
      byEndpoint[endpoint] = (byEndpoint[endpoint] ?? 0) + 1;
    }

    // ═══ Phase 1: Get a consular time ═══
    let consularDays;
    try {
      consularDays = await client.getConsularDays();
      count('getConsularDays');
      logger.info('Phase1: getConsularDays', { total: consularDays.length, first: consularDays[0]?.date });
    } catch (err) {
      count('getConsularDays');
      logger.error('Phase1: getConsularDays FAILED', { error: err instanceof Error ? err.message : String(err) });
      return { totalRequests, error: 'getConsularDays failed' };
    }

    let sampleTime: string | null = null;
    for (const cd of consularDays.slice(0, 3)) {
      try {
        const timesData = await client.getConsularTimes(cd.date);
        count('getConsularTimes');
        if (timesData.available_times?.length > 0) {
          sampleTime = timesData.available_times[0]!;
          logger.info('Phase1: got time', { date: cd.date, time: sampleTime });
          break;
        }
      } catch {
        count('getConsularTimes');
      }
      await sleep(500);
    }
    if (!sampleTime) {
      logger.error('No consular times found');
      return { totalRequests, error: 'no consular times' };
    }

    // ═══ Phase 2: Generate probes ═══
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0]!;
    const cutoff = new Date(today.getTime() + WINDOW_DAYS * 86400000).toISOString().split('T')[0]!;
    const probes: string[] = [];
    for (let offset = PROBE_INTERVAL; offset <= WINDOW_DAYS + 10; offset += PROBE_INTERVAL) {
      const d = new Date(today.getTime() + offset * 86400000);
      if (d.getDay() === 0) d.setDate(d.getDate() + 1);
      probes.push(d.toISOString().split('T')[0]!);
    }
    const samples = probes.slice(0, MAX_PROBES);
    logger.info('Phase2: probes', { samples, window: `${todayStr} → ${cutoff}` });

    // ═══ Phase 3: Discover CAS dates ═══
    const discoveredCasDates = new Set<string>();
    const probeDetails: { probe: string; dates: string[]; newDates: string[]; overlap: string[] }[] = [];

    for (let i = 0; i < samples.length; i++) {
      const probeDate = samples[i]!;
      try {
        const casDays = await client.getCasDays(probeDate, sampleTime);
        count('getCasDays');
        const inWindow = casDays.filter((d) => d.date >= todayStr && d.date <= cutoff);
        const dates = inWindow.map((d) => d.date).sort();
        const newDates = dates.filter((d) => !discoveredCasDates.has(d));
        const overlap = dates.filter((d) => discoveredCasDates.has(d));
        for (const d of dates) discoveredCasDates.add(d);
        probeDetails.push({ probe: probeDate, dates, newDates, overlap });
        logger.info(`Phase3: getCasDays(${probeDate})`, {
          total: casDays.length,
          inWindow: dates.length,
          new: newDates.length,
          overlap: overlap.length,
          dates: dates.join(', '),
          newDates: newDates.join(', '),
          overlapDates: overlap.join(', '),
        });
      } catch (err) {
        count('getCasDays');
        probeDetails.push({ probe: probeDate, dates: [], newDates: [], overlap: [] });
        logger.warn(`Phase3: getCasDays(${probeDate}) ERROR`, { error: err instanceof Error ? err.message : String(err) });
      }
      if (i < samples.length - 1) await sleep(500);
    }

    const uniqueCasDates = [...discoveredCasDates].sort();
    const totalReturned = probeDetails.reduce((s, p) => s + p.dates.length, 0);
    const totalNew = probeDetails.reduce((s, p) => s + p.newDates.length, 0);
    logger.info('Phase3: summary', {
      uniqueDates: uniqueCasDates.length,
      totalReturned,
      totalNew,
      overlapPct: totalReturned > 0 ? Math.round((totalReturned - totalNew) / totalReturned * 100) : 0,
      allDates: uniqueCasDates.join(', '),
    });

    // Per-probe efficiency
    for (const p of probeDetails) {
      const eff = p.dates.length > 0 ? `${Math.round(p.newDates.length / p.dates.length * 100)}%` : '-';
      logger.info(`Phase3: probe ${p.probe}`, {
        returned: p.dates.length,
        new: p.newDates.length,
        dup: p.overlap.length,
        efficiency: eff,
      });
    }

    if (uniqueCasDates.length === 0) {
      logger.info('No CAS dates in window');
      return { totalRequests, uniqueDates: 0, byEndpoint };
    }

    // ═══ Phase 4: Fetch CAS times ═══
    let fullCount = 0;
    let lowCount = 0;
    for (let i = 0; i < uniqueCasDates.length; i++) {
      if (totalRequests >= MAX_REQUESTS) {
        logger.warn('MAX_REQUESTS reached', { totalRequests, remaining: uniqueCasDates.length - i });
        break;
      }
      const casDate = uniqueCasDates[i]!;
      try {
        const timesData = await client.getCasTimes(casDate);
        count('getCasTimes');
        const slots = timesData.available_times?.length ?? 0;
        if (slots === 0) fullCount++;
        else if (slots <= 10) lowCount++;
        logger.info(`Phase4: getCasTimes(${casDate})`, { slots, status: slots === 0 ? 'FULL' : slots <= 10 ? 'LOW' : 'ok' });
      } catch (err) {
        count('getCasTimes');
        logger.warn(`Phase4: getCasTimes(${casDate}) ERROR`, { error: err instanceof Error ? err.message : String(err) });
      }
      if (i < uniqueCasDates.length - 1) await sleep(500);
    }

    const durationMs = Date.now() - globalStart;
    logger.info('DONE', {
      totalRequests,
      uniqueDates: uniqueCasDates.length,
      fullCount,
      lowCount,
      durationMs,
      byEndpoint,
    });

    return { totalRequests, uniqueDates: uniqueCasDates.length, fullCount, lowCount, durationMs, byEndpoint };
  },
});
