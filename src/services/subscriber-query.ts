import { db } from '../db/client.js';
import { bots, excludedDates } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { DaySlot } from './visa-client.js';
import { isDateExcluded, isAtLeastNDaysEarlier } from '../utils/date-helpers.js';
import type { DateRange } from '../utils/date-helpers.js';

export interface SubscriberCandidate {
  id: number;
  visaEmail: string;
  visaPassword: string;
  scheduleId: string;
  applicantIds: string[];
  consularFacilityId: string;
  ascFacilityId: string;
  locale: string;
  currentConsularDate: string;
  currentConsularTime: string | null;
  currentCasDate: string | null;
  currentCasTime: string | null;
  status: string;
  webhookUrl: string | null;
  notificationEmail: string | null;
  casCacheJson: unknown;
  userId: string | null;
  proxyProvider: string;
  exclusions: DateRange[];
  bestDate: string;
  improvementDays: number;
}

/**
 * Get active subscribers for a facility that would benefit from the available dates.
 * Returns subscribers sorted by improvement magnitude (largest first).
 */
export async function getSubscribersForFacility(
  facilityId: string,
  availableDates: DaySlot[],
  scoutBotId: number,
): Promise<SubscriberCandidate[]> {
  if (availableDates.length === 0) return [];

  // Query active subscribers — SELECT only needed columns (omit clerkUserId, activeRunId, etc.)
  const allSubscribers = await db
    .select({
      id: bots.id, status: bots.status, isSubscriber: bots.isSubscriber,
      visaEmail: bots.visaEmail, visaPassword: bots.visaPassword,
      scheduleId: bots.scheduleId, applicantIds: bots.applicantIds,
      consularFacilityId: bots.consularFacilityId, ascFacilityId: bots.ascFacilityId,
      locale: bots.locale, proxyProvider: bots.proxyProvider, userId: bots.userId,
      currentConsularDate: bots.currentConsularDate, currentConsularTime: bots.currentConsularTime,
      currentCasDate: bots.currentCasDate, currentCasTime: bots.currentCasTime,
      webhookUrl: bots.webhookUrl, notificationEmail: bots.notificationEmail,
      casCacheJson: bots.casCacheJson,
      targetDateBefore: bots.targetDateBefore,
      maxReschedules: bots.maxReschedules, rescheduleCount: bots.rescheduleCount,
    })
    .from(bots)
    .where(
      and(
        eq(bots.isSubscriber, true),
        eq(bots.consularFacilityId, facilityId),
        eq(bots.status, 'active'),
      ),
    );

  if (allSubscribers.length === 0) return [];

  // Load exclusions for all subscribers in bulk (filter in memory)
  const subscriberIds = new Set(allSubscribers.map((s) => s.id));
  const exclusionsByBot = new Map<number, DateRange[]>();
  const exRows = await db.select({
    botId: excludedDates.botId,
    startDate: excludedDates.startDate,
    endDate: excludedDates.endDate,
  }).from(excludedDates);
  for (const row of exRows) {
    if (!subscriberIds.has(row.botId)) continue;
    const list = exclusionsByBot.get(row.botId) ?? [];
    list.push({ startDate: row.startDate, endDate: row.endDate });
    exclusionsByBot.set(row.botId, list);
  }

  const candidates: SubscriberCandidate[] = [];

  for (const sub of allSubscribers) {
    if (!sub.currentConsularDate) continue;

    const exclusions = exclusionsByBot.get(sub.id) ?? [];

    // Hard limit: skip subscribers who exhausted their reschedule limit
    if (sub.maxReschedules != null && sub.rescheduleCount >= sub.maxReschedules) continue;

    // Find the best available date for this subscriber
    const bestDate = findBestDate(availableDates, sub.currentConsularDate, exclusions, sub.targetDateBefore);
    if (!bestDate) continue;

    const improvementDays = Math.floor(
      (new Date(sub.currentConsularDate).getTime() - new Date(bestDate).getTime()) / 86400000,
    );

    candidates.push({
      id: sub.id,
      visaEmail: sub.visaEmail,
      visaPassword: sub.visaPassword,
      scheduleId: sub.scheduleId,
      applicantIds: sub.applicantIds,
      consularFacilityId: sub.consularFacilityId,
      ascFacilityId: sub.ascFacilityId,
      locale: sub.locale,
      currentConsularDate: sub.currentConsularDate,
      currentConsularTime: sub.currentConsularTime,
      currentCasDate: sub.currentCasDate,
      currentCasTime: sub.currentCasTime,
      status: sub.status,
      webhookUrl: sub.webhookUrl,
      notificationEmail: sub.notificationEmail,
      casCacheJson: sub.casCacheJson,
      userId: sub.userId,
      proxyProvider: sub.proxyProvider,
      exclusions,
      bestDate,
      improvementDays,
    });
  }

  // Sort by improvement magnitude (largest first — Nov→Mar before Jun→Mar)
  candidates.sort((a, b) => b.improvementDays - a.improvementDays);

  return candidates;
}

/**
 * Find the best (earliest) available date for a subscriber,
 * filtering out their exclusions and requiring ≥1 day improvement.
 */
export function findBestDate(
  availableDates: DaySlot[],
  currentConsularDate: string,
  exclusions: DateRange[],
  targetDateBefore?: string | null,
): string | null {
  for (const day of availableDates) {
    if (isDateExcluded(day.date, exclusions)) continue;
    if (targetDateBefore && day.date >= targetDateBefore) continue;
    if (!isAtLeastNDaysEarlier(day.date, currentConsularDate, 1)) continue;
    return day.date;
  }
  return null;
}
