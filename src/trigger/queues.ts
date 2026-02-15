import { queue } from '@trigger.dev/sdk/v3';

export const visaPollingQueue = queue({
  name: 'visa-polling',
  concurrencyLimit: 10,
});

export const visaRescheduleQueue = queue({
  name: 'visa-reschedule',
  concurrencyLimit: 3,
});

export const visaLoginQueue = queue({
  name: 'visa-login',
  concurrencyLimit: 2,
});

export const visaNotifyQueue = queue({
  name: 'visa-notify',
  concurrencyLimit: 5,
});

