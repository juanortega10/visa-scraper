// Preview email — sends only to admin
import { notifyUser } from '../src/services/notifications.ts';

await notifyUser(
  {
    id: 16,
    notificationEmail: 'juanalbertoortega456@gmail.com',
    ownerEmail: null,
    webhookUrl: null,
  },
  'reschedule_success',
  {
    oldConsularDate: '2026-09-15',
    oldConsularTime: '10:00',
    oldCasDate: null,
    oldCasTime: null,
    newConsularDate: '2026-07-31',
    newConsularTime: '10:00',
    newCasDate: '2026-07-23',
    newCasTime: '07:00',
  },
);

console.log('Done.');
process.exit(0);
