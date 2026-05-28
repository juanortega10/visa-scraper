import { queue } from '@trigger.dev/sdk/v3';

export const visaPollingQueue = queue({
  name: 'visa-polling',
  concurrencyLimit: 10,
});

/** Per-bot polling queue. Each bot is serialized via concurrencyKey (poll-{botId}).
 * Global concurrencyLimit caps how many polls run simultaneously across all bots —
 * with 60+ active bots on the RPi (4 cores), 10 caused load avg 5+ and starved the
 * API. 4 keeps the RPi healthy; extra polls queue and run within 1-2s of their slot. */
export const visaPollingPerBotQueue = queue({
  name: 'visa-polling-per-bot',
  concurrencyLimit: 4,
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

