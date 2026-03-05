import { queue } from '@trigger.dev/sdk/v3';

export const visaPollingQueue = queue({
  name: 'visa-polling',
  concurrencyLimit: 10,
});

/** Per-bot polling queue: concurrencyLimit=1 so each concurrencyKey (poll-{botId}) runs 1 at a time. */
export const visaPollingPerBotQueue = queue({
  name: 'visa-polling-per-bot',
  concurrencyLimit: 1,
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

