import { task, logger } from '@trigger.dev/sdk/v3';
import { visaRescheduleQueue } from './queues.js';
import { db } from '../db/client.js';
import { bots, sessions, excludedDates, excludedTimes } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../services/encryption.js';
import { VisaClient } from '../services/visa-client.js';
import { executeReschedule } from '../services/reschedule-logic.js';
import type { ProxyProvider } from '../services/proxy-fetch.js';

interface ReschedulePayload {
  botId: number;
  targetDate: string;
  dryRun?: boolean;
}

export const rescheduleVisaTask = task({
  id: 'reschedule-visa',
  queue: visaRescheduleQueue,
  machine: { preset: 'micro' },
  maxDuration: 120,
  retry: { maxAttempts: 2 },

  run: async (payload: ReschedulePayload) => {
    const { botId, dryRun = false } = payload;
    logger.info('reschedule-visa START', { botId, targetDate: payload.targetDate, dryRun });

    const [bot] = await db.select({
      id: bots.id, scheduleId: bots.scheduleId, applicantIds: bots.applicantIds,
      consularFacilityId: bots.consularFacilityId, ascFacilityId: bots.ascFacilityId,
      locale: bots.locale, proxyProvider: bots.proxyProvider, userId: bots.userId,
      currentConsularDate: bots.currentConsularDate, currentConsularTime: bots.currentConsularTime,
      currentCasDate: bots.currentCasDate, currentCasTime: bots.currentCasTime,
      casCacheJson: bots.casCacheJson,
    }).from(bots).where(eq(bots.id, botId));
    if (!bot) throw new Error(`Bot ${botId} not found`);
    logger.info('Bot loaded', { botId, locale: bot.locale, consularFacility: bot.consularFacilityId, ascFacility: bot.ascFacilityId });

    const [session] = await db.select({
      yatriCookie: sessions.yatriCookie,
      csrfToken: sessions.csrfToken,
      authenticityToken: sessions.authenticityToken,
    }).from(sessions).where(eq(sessions.botId, botId));
    if (!session) throw new Error(`No session for bot ${botId}`);

    const exDates = await db.select({ startDate: excludedDates.startDate, endDate: excludedDates.endDate }).from(excludedDates).where(eq(excludedDates.botId, botId));
    const exTimes = await db.select({ date: excludedTimes.date, timeStart: excludedTimes.timeStart, timeEnd: excludedTimes.timeEnd }).from(excludedTimes).where(eq(excludedTimes.botId, botId));

    let cookie: string;
    try {
      cookie = decrypt(session.yatriCookie);
    } catch (e) {
      throw new Error(`Failed to decrypt session for bot ${botId}: ${e}`);
    }

    const client = new VisaClient(
      {
        cookie,
        csrfToken: session.csrfToken ?? '',
        authenticityToken: session.authenticityToken ?? '',
      },
      {
        scheduleId: bot.scheduleId,
        applicantIds: bot.applicantIds,
        consularFacilityId: bot.consularFacilityId,
        ascFacilityId: bot.ascFacilityId,
        proxyProvider: bot.proxyProvider as ProxyProvider,
        userId: bot.userId,
        locale: bot.locale,
      },
    );

    const dateExclusions = exDates.map((d) => ({ startDate: d.startDate, endDate: d.endDate }));
    const timeExclusions = exTimes.map((t) => ({
      date: t.date,
      timeStart: t.timeStart,
      timeEnd: t.timeEnd,
    }));

    const pending: Promise<unknown>[] = [];
    const result = await executeReschedule({
      client,
      botId,
      bot,
      dateExclusions,
      timeExclusions,
      dryRun,
      pending,
    });
    await Promise.allSettled(pending);
    return result;
  },
});
