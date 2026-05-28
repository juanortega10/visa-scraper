import { pureFetchLogin } from '../src/services/login.js';
import { USER_AGENT } from '../src/utils/constants.js';

const email = 'yave.oliva@gmail.com';
const password = 'Ce672dfd9c$danyella';
const locale = 'es-mx';
const scheduleId = '73953657';

const login = await pureFetchLogin({ email, password, scheduleId, applicantIds: [], locale }, { skipTokens: true });
const baseUrl = `https://ais.usvisa-info.com/${locale}/niv`;
const cookieHeader = `_yatri_session=${login.cookie}`;

const apptResp = await fetch(`${baseUrl}/schedule/${scheduleId}/appointment`, {
  headers: { Cookie: cookieHeader, 'User-Agent': USER_AGENT, Accept: 'text/html' },
  redirect: 'follow',
});
const html = await apptResp.text();
console.log(`status=${apptResp.status} len=${html.length}\n`);

// Dump the consular <select> in full
const consSel = html.match(/<select[^>]+consulate_appointment_facility_id[^>]*>[\s\S]*?<\/select>/);
console.log('=== CONSULAR <select> ===');
console.log(consSel?.[0] ?? '(not found)');

console.log('\n=== ASC <select> ===');
const ascSel = html.match(/<select[^>]+asc_appointment_facility_id[^>]*>[\s\S]*?<\/select>/);
console.log(ascSel?.[0] ?? '(not found)');

// Look for hidden inputs that store current facility
console.log('\n=== Hidden inputs with facility/consulate keyword ===');
const hidden = html.matchAll(/<input[^>]+type="hidden"[^>]*>/g);
for (const m of hidden) {
  if (/facility|consulate|asc/i.test(m[0])) console.log(m[0]);
}

// Check forms with action containing schedule
console.log('\n=== <form> actions ===');
const forms = html.matchAll(/<form[^>]+action="([^"]+)"[^>]*>/g);
for (const m of forms) console.log(m[1]);

// All data-* attributes types found
console.log('\n=== Unique data-* attribute names on <option> ===');
const dataAttrs = new Set<string>();
const optTags = html.matchAll(/<option[^>]+>/g);
for (const m of optTags) {
  const attrs = m[0].matchAll(/(data-[a-z-]+)=/g);
  for (const a of attrs) dataAttrs.add(a[1]!);
}
console.log([...dataAttrs]);
