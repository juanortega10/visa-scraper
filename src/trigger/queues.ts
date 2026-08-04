import { queue } from '@trigger.dev/sdk/v3';

export const visaPollingQueue = queue({
  name: 'visa-polling',
  concurrencyLimit: 10,
});

/** Per-bot polling queue. Each bot is serialized via concurrencyKey (poll-{botId}).
 * Global concurrencyLimit caps how many polls run simultaneously across all bots —
 * with 60+ active bots on the RPi (4 cores), 10 caused load avg 5+ and starved the
 * API. Raised 4→8 (2026-06-09): with 36 active bots, 4 slots starved newly-onboarded
 * chainless bots (their cron runs were superseded/Cancelled-0ms before getting a slot,
 * so they never executed a first poll → never self-chained). Watch RPi load avg. */
export const visaPollingPerBotQueue = queue({
  name: 'visa-polling-per-bot',
  concurrencyLimit: 8,
});

export const visaRescheduleQueue = queue({
  name: 'visa-reschedule',
  concurrencyLimit: 3,
});

/** Per-bot reschedule queue: serializes reschedules per bot (concurrencyKey = reschedule-{botId}). */
export const visaReschedulePerBotQueue = queue({
  name: 'visa-reschedule-per-bot',
  concurrencyLimit: 1,
});

export const visaLoginQueue = queue({
  name: 'visa-login',
  concurrencyLimit: 2,
});

export const visaNotifyQueue = queue({
  name: 'visa-notify',
  concurrencyLimit: 5,
});

/** Agency bulk-discovery queue. Conservative concurrency to avoid portal bans when
 * an agency validates dozens/hundreds of client accounts at once (each does a login). */
export const agencyDiscoverQueue = queue({
  name: 'agency-discover',
  concurrencyLimit: 3,
});

