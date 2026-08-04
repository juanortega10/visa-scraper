import { pureFetchLogin } from '../src/services/login.ts';
import { extractGroups } from '../src/services/html-parsers.ts';
import { writeFileSync } from 'fs';

// NIV login using the niv endpoint directly
const BASE = 'https://ais.usvisa-info.com/es-co/niv';
const email = 'jmendiaco@gmail.com';
const password = 'Julianydiegoyjk0509#';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Step 1: GET sign_in page
const signInPage = await fetch(`${BASE}/users/sign_in`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
const signInHtml = await signInPage.text();
const setCookieRaw = signInPage.headers.get('set-cookie') ?? '';
const sessionMatch = setCookieRaw.match(/_yatri_session=([^;]+)/);
let cookie = sessionMatch?.[1] ?? '';
const csrfMatch = signInHtml.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/);
const csrf = csrfMatch?.[1] ?? '';
console.log('Step1: cookie length', cookie.length, 'csrf length', csrf.length);

// Step 2: POST login
const loginBody = new URLSearchParams({
  utf8: '✓',
  authenticity_token: csrf,
  'user[email]': email,
  'user[password]': password,
  policy_confirmed: '1',
  commit: 'Iniciar Sesión',
});
const loginResp = await fetch(`${BASE}/users/sign_in`, {
  method: 'POST',
  headers: {
    'User-Agent': UA,
    Cookie: `_yatri_session=${cookie}`,
    'X-CSRF-Token': csrf,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*',
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: loginBody.toString(),
  redirect: 'follow',
});
const loginSetCookie = loginResp.headers.get('set-cookie') ?? '';
const loginSession = loginSetCookie.match(/_yatri_session=([^;]+)/)?.[1];
if (loginSession) cookie = loginSession;
console.log('Step2: status', loginResp.status, 'new cookie length', cookie.length);

// Step 3: GET /account (follows redirect to /groups/{userId})
const accountResp = await fetch(`${BASE}/account`, {
  headers: { 'User-Agent': UA, Cookie: `_yatri_session=${cookie}`, Accept: 'text/html' },
  redirect: 'follow',
});
console.log('Step3: status', accountResp.status, 'url', accountResp.url);
const groupsHtml = await accountResp.text();
writeFileSync('/tmp/groups-jm.html', groupsHtml);
console.log('Saved HTML, length:', groupsHtml.length);

const groups = extractGroups(groupsHtml);
console.log('\nGroups:');
for (const g of groups) {
  console.log(JSON.stringify({ sched: g.scheduleId, names: g.applicantNames, date: g.currentConsularDate }));
}
