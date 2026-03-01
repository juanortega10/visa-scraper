/**
 * Blocking experiments — decompose what triggers IP blocking on ais.usvisa-info.com.
 *
 * SAFETY: NEVER does POST to /appointment (reschedule). Only GET requests + POST sign_in (login).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/blocking-experiments.ts --exp=1
 *   npx tsx --env-file=.env scripts/blocking-experiments.ts --exp=2
 *   npx tsx --env-file=.env scripts/blocking-experiments.ts --exp=1,2,3
 *   npx tsx --env-file=.env scripts/blocking-experiments.ts --exp=all
 *
 * Exp 9-12 added 2026-02-20:
 *   9   days.json Rate Ramp (authenticated, single IP ~40min)
 *   10  Multi-IP Sustained (5 IPs round-robin, days.json ~30min)
 *   11  Peru Endpoint (es-pe vs es-co, same IP ~20min)
 *   12  POST via Webshare (safe dry-run with invalid date ~2min)
 */
import { ProxyAgent } from 'undici';

// ── Constants ──────────────────────────────────────────────────

const BASE_URL = 'https://ais.usvisa-info.com/es-co/niv';
const SIGN_IN_URL = `${BASE_URL}/users/sign_in`;
const SCHEDULE_ID = '72824354';
const FACILITY_ID = '25';
const DAYS_URL = `${BASE_URL}/schedule/${SCHEDULE_ID}/appointment/days/${FACILITY_ID}.json?appointments[expedite]=false`;
const APPLICANT_IDS = ['87117943', '87126508'];

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

const BROWSER_HEADERS: Record<string, string> = {
  'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
};

const WS_USER = 'nfxniwxh';
const WS_PASS = '2zobtqlpwn1o';

interface ProxyIP {
  label: string;
  ip: string;
  port: number;
}

const ALL_IPS: ProxyIP[] = [
  { label: '#1 Buffalo',         ip: '23.95.150.145',    port: 6114 },
  { label: '#2 Buffalo',         ip: '198.23.239.134',   port: 6540 },
  { label: '#3 Bloomingdale',    ip: '107.172.163.27',   port: 6543 },
  { label: '#4 Dallas',          ip: '216.10.27.159',    port: 6837 },
  { label: '#5 LA',              ip: '23.229.19.94',     port: 8689 },
  { label: '#6 London',          ip: '31.59.20.176',     port: 6754 },
  { label: '#7 London',          ip: '45.38.107.97',     port: 6014 },
  { label: '#8 City of London',  ip: '198.105.121.200',  port: 6462 },
  { label: '#9 Madrid',          ip: '64.137.96.74',     port: 6641 },
  { label: '#10 Tokyo',          ip: '142.111.67.146',   port: 5611 },
];

function getIP(num: number): ProxyIP {
  const ip = ALL_IPS.find((p) => p.label.startsWith(`#${num} `));
  if (!ip) throw new Error(`IP #${num} not found`);
  return ip;
}

function proxyUrl(ip: ProxyIP): string {
  return `http://${WS_USER}:${WS_PASS}@${ip.ip}:${ip.port}`;
}

// ── Types ──────────────────────────────────────────────────────

interface ProbeResult {
  timestamp: string;
  experiment: number;
  stream?: string;
  phase?: number;
  ip: string;
  target: string;
  headers: string;
  authenticated: boolean;
  httpStatus?: number;
  status: 'ok' | 'blocked' | 'timeout' | 'error';
  latencyMs: number;
  bodySnippet?: string;
  error?: string;
  reqNum?: number;
}

// ── Logging ────────────────────────────────────────────────────

const allResults: ProbeResult[] = [];

function logResult(r: ProbeResult) {
  allResults.push(r);
  const icon = r.status === 'ok' ? '  ✓' : r.status === 'blocked' ? '  ✗' : '  ⚠';
  const detail = r.error ? r.error.substring(0, 60) : `HTTP ${r.httpStatus ?? '?'}`;
  console.log(
    `${icon} ${r.timestamp.split('T')[1]?.substring(0, 8) ?? ''} ${(r.stream ?? '').padEnd(6)} ` +
    `req#${String(r.reqNum ?? 0).padStart(3)} ${r.status.padEnd(8)} ${detail.padEnd(50)} ${r.latencyMs}ms`,
  );
}

function now(): string {
  return new Date().toISOString();
}

function bogotaTime(): string {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Bogota', hour12: false });
}

// ── Core probe ─────────────────────────────────────────────────

interface ProbeConfig {
  experiment: number;
  stream?: string;
  phase?: number;
  ip: ProxyIP;
  url: string;
  headers: Record<string, string>;
  authenticated: boolean;
  headersLabel: string;
  reqNum?: number;
  timeoutMs?: number;
}

async function probe(cfg: ProbeConfig): Promise<ProbeResult> {
  const agent = new ProxyAgent({ uri: proxyUrl(cfg.ip) });
  const start = Date.now();

  try {
    const resp = await fetch(cfg.url, {
      headers: cfg.headers,
      // @ts-expect-error undici dispatcher
      dispatcher: agent,
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 15000),
      redirect: 'manual',
    });

    const latencyMs = Date.now() - start;
    const body = await resp.text();
    const bodySnippet = body.substring(0, 100).replace(/\n/g, ' ').trim();

    // Determine status
    let status: ProbeResult['status'] = 'error';
    if (cfg.url.includes('.json')) {
      // JSON endpoint — 200 + array = ok
      status = resp.status === 200 && (body.startsWith('[') || body.startsWith('{')) ? 'ok' : 'blocked';
    } else if (cfg.url.includes('sign_in')) {
      // HTML page — 200 + sign_in content = ok
      const hasContent = body.includes('sign_in') || body.includes('Sign In') || body.includes('Iniciar');
      status = resp.status === 200 && hasContent ? 'ok' : 'blocked';
    } else {
      status = resp.status === 200 ? 'ok' : 'blocked';
    }

    // 302 to sign_in for authenticated requests = session issue, not blocking
    if (resp.status === 302) {
      const location = resp.headers.get('location') ?? '';
      status = location.includes('sign_in') ? 'blocked' : 'ok';
    }

    const result: ProbeResult = {
      timestamp: now(),
      experiment: cfg.experiment,
      stream: cfg.stream,
      phase: cfg.phase,
      ip: cfg.ip.ip,
      target: cfg.url.includes('.json') ? 'days.json' : cfg.url.includes('sign_in') ? 'sign_in' : 'appointment',
      headers: cfg.headersLabel,
      authenticated: cfg.authenticated,
      httpStatus: resp.status,
      status,
      latencyMs,
      bodySnippet,
      reqNum: cfg.reqNum,
    };
    logResult(result);
    return result;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('timeout') || msg.includes('abort');

    const result: ProbeResult = {
      timestamp: now(),
      experiment: cfg.experiment,
      stream: cfg.stream,
      phase: cfg.phase,
      ip: cfg.ip.ip,
      target: cfg.url.includes('.json') ? 'days.json' : cfg.url.includes('sign_in') ? 'sign_in' : 'other',
      headers: cfg.headersLabel,
      authenticated: cfg.authenticated,
      httpStatus: undefined,
      status: isTimeout ? 'timeout' : 'error',
      latencyMs,
      error: msg.substring(0, 120),
      reqNum: cfg.reqNum,
    };
    logResult(result);
    return result;
  } finally {
    await agent.close().catch(() => {});
  }
}

// ── Rate loop helper ───────────────────────────────────────────

interface RateLoopConfig {
  experiment: number;
  stream?: string;
  phase?: number;
  ip: ProxyIP;
  url: string;
  headers: Record<string, string>;
  headersLabel: string;
  authenticated: boolean;
  ratePerMin: number;
  durationMin: number;
}

async function rateLoop(cfg: RateLoopConfig): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const intervalMs = (60 / cfg.ratePerMin) * 1000;
  const totalRequests = Math.ceil(cfg.ratePerMin * cfg.durationMin);
  let reqNum = 0;

  console.log(
    `\n  → Rate loop: ${cfg.ratePerMin}/min × ${cfg.durationMin}min = ~${totalRequests} req ` +
    `(interval ${Math.round(intervalMs)}ms) via ${cfg.ip.label}`,
  );

  for (let i = 0; i < totalRequests; i++) {
    reqNum++;
    const r = await probe({ ...cfg, reqNum });
    results.push(r);

    // If blocked, do 3 more confirmatory probes then stop
    if (r.status === 'blocked' || r.status === 'timeout') {
      console.log(`  ⚠ Potential block at req #${reqNum}, confirming with 3 more probes...`);
      let confirmBlocked = 0;
      for (let j = 0; j < 3; j++) {
        await sleep(2000);
        reqNum++;
        const cr = await probe({ ...cfg, reqNum });
        results.push(cr);
        if (cr.status === 'blocked' || cr.status === 'timeout') confirmBlocked++;
      }
      if (confirmBlocked >= 2) {
        console.log(`  ✗ CONFIRMED BLOCKED at req #${reqNum - 3} (${confirmBlocked}/3 confirmations)`);
        break;
      }
      console.log(`  ✓ False alarm — only ${confirmBlocked}/3 blocked, continuing`);
    }

    if (i < totalRequests - 1) await sleep(intervalMs);
  }

  return results;
}

// ── Login helper (direct, no proxy) ────────────────────────────

interface SessionInfo {
  cookie: string;
  csrf: string;
}

async function loginDirect(): Promise<SessionInfo> {
  const email = process.env.TEST_EMAIL ?? 'juanalbertoortega456@gmail.com';
  const password = process.env.TEST_PASSWORD ?? 'Visacolombia2026.';

  // Step 1: GET sign_in → cookie + CSRF
  const getResp = await fetch('https://ais.usvisa-info.com/es-co/iv/users/sign_in', {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
  });

  let yatriCookie = '';
  for (const h of getResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { yatriCookie = m[1]; break; }
  }
  if (!yatriCookie) throw new Error('No _yatri_session from GET sign_in');

  const html = await getResp.text();
  const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!csrfMatch?.[1]) throw new Error('No CSRF in sign_in HTML');

  // Step 2: POST sign_in
  const postResp = await fetch(`${BASE_URL}/users/sign_in`, {
    method: 'POST',
    headers: {
      Accept: '*/*;q=0.5, text/javascript, application/javascript',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Cookie: `_yatri_session=${yatriCookie}`,
      Origin: 'https://ais.usvisa-info.com',
      Referer: SIGN_IN_URL,
      'User-Agent': USER_AGENT,
      'X-CSRF-Token': csrfMatch[1],
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({
      'user[email]': email,
      'user[password]': password,
      policy_confirmed: '1',
      commit: 'Iniciar sesión',
    }).toString(),
    redirect: 'manual',
  });

  const postBody = await postResp.text();
  if (postBody.includes('inválida')) throw new Error('Invalid credentials');

  let newCookie = '';
  for (const h of postResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { newCookie = m[1]; break; }
  }
  if (!newCookie) throw new Error('No session cookie from POST sign_in');

  // Step 3: GET appointment page → fresh CSRF
  const qs = APPLICANT_IDS.map((id) => `applicants[]=${id}`).join('&');
  const apptUrl = `${BASE_URL}/schedule/${SCHEDULE_ID}/appointment?${qs}&confirmed_limit_message=1&commit=Continuar`;

  const apptResp = await fetch(apptUrl, {
    headers: {
      Cookie: `_yatri_session=${newCookie}`,
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
    },
    redirect: 'manual',
  });

  // Update cookie from appointment response
  for (const h of apptResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { newCookie = m[1]; break; }
  }

  if (apptResp.status !== 200) {
    console.warn(`  [login] Appointment page HTTP ${apptResp.status} — using CSRF from sign_in`);
    return { cookie: newCookie, csrf: csrfMatch[1] };
  }

  const apptHtml = await apptResp.text();
  const apptCsrf = apptHtml.match(/<meta name="csrf-token" content="([^"]+)"/);

  return {
    cookie: newCookie,
    csrf: apptCsrf?.[1] ?? csrfMatch[1],
  };
}

// ── Full-flow login via proxy (Exp 8) ──────────────────────────

async function loginViaProxy(ip: ProxyIP): Promise<SessionInfo> {
  const email = process.env.TEST_EMAIL ?? 'juanalbertoortega456@gmail.com';
  const password = process.env.TEST_PASSWORD ?? 'Visacolombia2026.';
  const pUrl = proxyUrl(ip);

  // Step 1: GET sign_in via proxy
  const agent1 = new ProxyAgent({ uri: pUrl });
  const getResp = await fetch('https://ais.usvisa-info.com/es-co/iv/users/sign_in', {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    // @ts-expect-error undici dispatcher
    dispatcher: agent1,
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });

  let yatriCookie = '';
  for (const h of getResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { yatriCookie = m[1]; break; }
  }
  if (!yatriCookie) throw new Error(`No _yatri_session from GET sign_in via ${ip.label}`);

  const html = await getResp.text();
  const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!csrfMatch?.[1]) throw new Error('No CSRF');
  await agent1.close().catch(() => {});

  // Step 2: POST sign_in via proxy
  const agent2 = new ProxyAgent({ uri: pUrl });
  const postResp = await fetch(`${BASE_URL}/users/sign_in`, {
    method: 'POST',
    headers: {
      Accept: '*/*;q=0.5, text/javascript, application/javascript',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Cookie: `_yatri_session=${yatriCookie}`,
      Origin: 'https://ais.usvisa-info.com',
      Referer: SIGN_IN_URL,
      'User-Agent': USER_AGENT,
      'X-CSRF-Token': csrfMatch[1],
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({
      'user[email]': email,
      'user[password]': password,
      policy_confirmed: '1',
      commit: 'Iniciar sesión',
    }).toString(),
    // @ts-expect-error undici dispatcher
    dispatcher: agent2,
    signal: AbortSignal.timeout(15000),
    redirect: 'manual',
  });

  const postBody = await postResp.text();
  if (postBody.includes('inválida')) throw new Error('Invalid credentials');

  let newCookie = '';
  for (const h of postResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { newCookie = m[1]; break; }
  }
  if (!newCookie) throw new Error('No cookie from POST');
  await agent2.close().catch(() => {});

  // Step 3: GET appointment page via proxy
  const agent3 = new ProxyAgent({ uri: pUrl });
  const qs = APPLICANT_IDS.map((id) => `applicants[]=${id}`).join('&');
  const apptUrl = `${BASE_URL}/schedule/${SCHEDULE_ID}/appointment?${qs}&confirmed_limit_message=1&commit=Continuar`;

  const apptResp = await fetch(apptUrl, {
    headers: {
      Cookie: `_yatri_session=${newCookie}`,
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
      'Upgrade-Insecure-Requests': '1',
      ...BROWSER_HEADERS,
    },
    // @ts-expect-error undici dispatcher
    dispatcher: agent3,
    signal: AbortSignal.timeout(15000),
    redirect: 'manual',
  });

  for (const h of apptResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { newCookie = m[1]; break; }
  }

  let csrf = csrfMatch[1];
  if (apptResp.status === 200) {
    const apptHtml = await apptResp.text();
    const mc = apptHtml.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (mc?.[1]) csrf = mc[1];
  }
  await agent3.close().catch(() => {});

  console.log(`  ✓ Full-flow login via ${ip.label} complete`);
  return { cookie: newCookie, csrf };
}

// ── AJAX headers builder ───────────────────────────────────────

function ajaxHeaders(session: SessionInfo): Record<string, string> {
  return {
    Cookie: `_yatri_session=${session.cookie}`,
    'X-CSRF-Token': session.csrf,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'User-Agent': USER_AGENT,
    Referer: `${BASE_URL}/schedule/${SCHEDULE_ID}/appointment`,
    ...BROWSER_HEADERS,
  };
}

// ── Header sets for Exp 3 ──────────────────────────────────────

function fullBrowserHeaders(): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: 'https://ais.usvisa-info.com/',
    ...BROWSER_HEADERS,
  };
}

function minimalHeaders(): Record<string, string> {
  return { 'User-Agent': USER_AGENT };
}

function xhrStyleHeaders(): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
  };
}

function curlLikeHeaders(): Record<string, string> {
  return {}; // bare Node fetch defaults
}

// ── Sleep ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Experiments ────────────────────────────────────────────────

// Exp 1: Rate Ramp — threshold per IP on public endpoint
async function exp1_rateRamp() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 1: Rate Ramp — threshold per IP (public sign_in)');
  console.log(`IP: #4 Dallas | Target: sign_in | Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  const ip = getIP(4);
  const phases = [
    { rate: 1, min: 5 },
    { rate: 2, min: 5 },
    { rate: 3, min: 5 },
    { rate: 4, min: 5 },
    { rate: 6, min: 5 },
    { rate: 10, min: 5 },
    { rate: 20, min: 5 },
  ];

  let totalSent = 0;
  let firstBlockPhase: number | null = null;

  for (let p = 0; p < phases.length; p++) {
    const phase = phases[p]!;
    console.log(`\n  Phase ${p + 1}: ${phase.rate}/min × ${phase.min}min (cumulative: ~${totalSent} sent)`);

    const results = await rateLoop({
      experiment: 1,
      phase: p + 1,
      ip,
      url: SIGN_IN_URL,
      headers: fullBrowserHeaders(),
      headersLabel: 'full_browser',
      authenticated: false,
      ratePerMin: phase.rate,
      durationMin: phase.min,
    });

    const ok = results.filter((r) => r.status === 'ok').length;
    const blocked = results.filter((r) => r.status !== 'ok').length;
    totalSent += results.length;

    console.log(`  Phase ${p + 1} summary: ${ok} ok, ${blocked} blocked (total sent: ${totalSent})`);

    if (blocked > 0 && firstBlockPhase === null) {
      firstBlockPhase = p + 1;
      console.log(`  ⚠ First block in phase ${p + 1} at rate ${phase.rate}/min`);
      // Continue to next phase to see if it persists
    }

    // If most requests blocked, stop
    if (blocked > results.length * 0.7) {
      console.log(`  ✗ >70% blocked — stopping ramp`);
      break;
    }
  }

  console.log(`\n  RESULT: First block at phase ${firstBlockPhase ?? 'none'}, total requests: ${totalSent}`);
}

// Exp 2: Endpoint Sensitivity — public vs authenticated vs anon-to-JSON
async function exp2_endpointSensitivity() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 2: Endpoint Sensitivity — public vs authenticated vs anon-to-JSON');
  console.log(`Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  // Pre-req: login for authenticated stream
  console.log('\n  Logging in (direct) for authenticated stream B...');
  const session = await loginDirect();
  console.log(`  ✓ Session obtained (cookie ${session.cookie.length} chars)`);

  const rate = 3;
  const duration = 8;

  // Stream A: public sign_in, no auth
  console.log(`\n  STREAM A: sign_in (public) via #1 Buffalo`);
  await rateLoop({
    experiment: 2, stream: 'A', ip: getIP(1),
    url: SIGN_IN_URL, headers: fullBrowserHeaders(), headersLabel: 'full_browser',
    authenticated: false, ratePerMin: rate, durationMin: duration,
  });

  await sleep(5000); // brief cooldown between streams

  // Stream B: days.json with auth
  console.log(`\n  STREAM B: days.json (authenticated) via #7 London`);
  await rateLoop({
    experiment: 2, stream: 'B', ip: getIP(7),
    url: DAYS_URL, headers: ajaxHeaders(session), headersLabel: 'ajax_auth',
    authenticated: true, ratePerMin: rate, durationMin: duration,
  });

  await sleep(5000);

  // Stream C: days.json without auth (expect 302)
  console.log(`\n  STREAM C: days.json (no auth) via #9 Madrid`);
  await rateLoop({
    experiment: 2, stream: 'C', ip: getIP(9),
    url: DAYS_URL,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    headersLabel: 'no_auth',
    authenticated: false, ratePerMin: rate, durationMin: duration,
  });
}

// Exp 3: Header Sensitivity
async function exp3_headerSensitivity() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 3: Header Sensitivity — do headers matter?');
  console.log(`Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  const rate = 3;
  const duration = 6;

  const streams: { label: string; ip: ProxyIP; headers: Record<string, string>; headersLabel: string }[] = [
    { label: 'A (full browser)', ip: getIP(2), headers: fullBrowserHeaders(), headersLabel: 'full_browser' },
    { label: 'B (minimal)',      ip: getIP(5), headers: minimalHeaders(),     headersLabel: 'minimal' },
    { label: 'C (XHR-style)',    ip: getIP(8), headers: xhrStyleHeaders(),    headersLabel: 'xhr' },
    { label: 'D (curl-like)',    ip: getIP(6), headers: curlLikeHeaders(),    headersLabel: 'curl' },
  ];

  for (const s of streams) {
    console.log(`\n  STREAM ${s.label} via ${s.ip.label}`);
    await rateLoop({
      experiment: 3, stream: s.label.charAt(0), ip: s.ip,
      url: SIGN_IN_URL, headers: s.headers, headersLabel: s.headersLabel,
      authenticated: false, ratePerMin: rate, durationMin: duration,
    });
    await sleep(5000);
  }
}

// Exp 4: Cross-IP Session Sharing
async function exp4_crossIpSession() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 4: Cross-IP Session Sharing');
  console.log(`Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  // Login from direct (RPi)
  console.log('\n  Logging in (direct)...');
  const session = await loginDirect();
  console.log(`  ✓ Session obtained`);

  const ips = [getIP(1), getIP(4), getIP(5), getIP(7)];
  const headers = ajaxHeaders(session);

  // Phase 1: Single request from each IP to verify cross-IP works
  console.log('\n  Phase 1: Single request from each IP');
  for (const ip of ips) {
    await probe({
      experiment: 4, stream: 'verify', ip,
      url: DAYS_URL, headers, headersLabel: 'ajax_auth',
      authenticated: true, reqNum: 0,
    });
    await sleep(1000);
  }

  // Phase 2: Round-robin at 4 req/min total (1/min per IP) × 5 min
  console.log('\n  Phase 2: Round-robin 4 req/min total (1/IP/min) × 5 min');
  const phase2Total = 20; // 4/min × 5min
  for (let i = 0; i < phase2Total; i++) {
    const ip = ips[i % ips.length]!;
    await probe({
      experiment: 4, stream: 'rr-4', ip,
      url: DAYS_URL, headers, headersLabel: 'ajax_auth',
      authenticated: true, reqNum: i + 1,
    });
    await sleep(15000); // 60s / 4 = 15s
  }

  // Phase 3: Round-robin at 8 req/min total (2/min per IP) × 5 min
  console.log('\n  Phase 3: Round-robin 8 req/min total (2/IP/min) × 5 min');
  const phase3Total = 40;
  for (let i = 0; i < phase3Total; i++) {
    const ip = ips[i % ips.length]!;
    await probe({
      experiment: 4, stream: 'rr-8', ip,
      url: DAYS_URL, headers, headersLabel: 'ajax_auth',
      authenticated: true, reqNum: i + 1,
    });
    await sleep(7500); // 60s / 8 = 7.5s
  }
}

// Exp 5: Recovery Time
async function exp5_recovery() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 5: Recovery Time');
  console.log(`Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  // Find a previously blocked IP, or hammer #4 until blocked
  const ip = getIP(4);
  console.log(`\n  Using ${ip.label} — confirming it's blocked...`);

  // Check if already blocked
  let isBlocked = true;
  for (let i = 0; i < 3; i++) {
    const r = await probe({
      experiment: 5, stream: 'check', ip,
      url: SIGN_IN_URL, headers: fullBrowserHeaders(), headersLabel: 'full_browser',
      authenticated: false, reqNum: i,
    });
    if (r.status === 'ok') isBlocked = false;
    await sleep(2000);
  }

  if (!isBlocked) {
    console.log('  IP is not blocked. Hammering at 20/min until block...');
    const results = await rateLoop({
      experiment: 5, stream: 'hammer', ip,
      url: SIGN_IN_URL, headers: fullBrowserHeaders(), headersLabel: 'full_browser',
      authenticated: false, ratePerMin: 20, durationMin: 10,
    });

    const lastResult = results[results.length - 1];
    if (!lastResult || lastResult.status === 'ok') {
      console.log('  Could not trigger block at 20/min for 10min — aborting recovery test');
      return;
    }
  }

  console.log('\n  IP confirmed blocked. Starting recovery monitoring (1 req / 2min × 40 min)...');

  let recoveredAt: number | null = null;
  const startTime = Date.now();

  for (let i = 0; i < 20; i++) {
    const elapsed = Math.round((Date.now() - startTime) / 60000);
    const r = await probe({
      experiment: 5, stream: 'recover', ip,
      url: SIGN_IN_URL, headers: fullBrowserHeaders(), headersLabel: 'full_browser',
      authenticated: false, reqNum: i,
    });

    if (r.status === 'ok' && recoveredAt === null) {
      recoveredAt = elapsed;
      console.log(`  ✓ RECOVERED at ${elapsed} minutes post-block`);
      // Continue monitoring for a few more to confirm stability
    }

    if (recoveredAt !== null && i >= 3) {
      console.log(`  Recovery confirmed stable. Elapsed: ${elapsed} min`);
      break;
    }

    await sleep(120000); // 2 min
  }

  if (recoveredAt === null) {
    console.log(`  ✗ NOT recovered after 40 minutes`);
  }
}

// Exp 6: Datacenter vs Residential
async function exp6_dcVsResidential() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 6: Datacenter vs Residential');
  console.log(`Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  const rate = 6;
  const duration = 15;

  // Webshare DC — via proxy
  console.log(`\n  Stream A: Webshare DC (#9 Madrid) at ${rate}/min × ${duration}min`);
  const dcPromise = rateLoop({
    experiment: 6, stream: 'DC', ip: getIP(9),
    url: SIGN_IN_URL, headers: fullBrowserHeaders(), headersLabel: 'full_browser',
    authenticated: false, ratePerMin: rate, durationMin: duration,
  });

  // RPi + Cloud: via Trigger.dev tasks
  // These need to be triggered separately — output instructions
  console.log(`\n  NOTE: For RPi + Cloud comparison, trigger probe-blocking task:`);
  console.log(`    Dev (RPi):   trigger_task probe-blocking { url: "${SIGN_IN_URL}", count: ${rate * duration}, delayMs: ${Math.round(60000 / rate)} }`);
  console.log(`    Prod (Cloud): trigger_task probe-blocking { url: "${SIGN_IN_URL}", count: ${rate * duration}, delayMs: ${Math.round(60000 / rate)} } environment=prod`);

  await dcPromise;
}

// Exp 7: Subnet/Range Blocking
async function exp7_subnetBlocking() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 7: Subnet/Range Blocking');
  console.log(`Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  const ip1 = getIP(1); // 23.95.150.x Buffalo
  const ip2 = getIP(2); // 198.23.239.x Buffalo (different subnet)
  const ip4 = getIP(4); // Dallas (different DC, control)

  // Hammer IP #1 at 20/min until blocked
  console.log(`\n  Hammering ${ip1.label} at 20/min until blocked...`);
  await rateLoop({
    experiment: 7, stream: 'hammer', ip: ip1,
    url: SIGN_IN_URL, headers: fullBrowserHeaders(), headersLabel: 'full_browser',
    authenticated: false, ratePerMin: 20, durationMin: 10,
  });

  console.log(`\n  Checking if ${ip2.label} (same DC, different subnet) is contaminated...`);
  for (let i = 0; i < 5; i++) {
    await probe({
      experiment: 7, stream: 'same-dc', ip: ip2,
      url: SIGN_IN_URL, headers: fullBrowserHeaders(), headersLabel: 'full_browser',
      authenticated: false, reqNum: i,
    });
    await sleep(10000);
  }

  console.log(`\n  Checking ${ip4.label} (different DC, control)...`);
  for (let i = 0; i < 5; i++) {
    await probe({
      experiment: 7, stream: 'control', ip: ip4,
      url: SIGN_IN_URL, headers: fullBrowserHeaders(), headersLabel: 'full_browser',
      authenticated: false, reqNum: i,
    });
    await sleep(10000);
  }
}

// Exp 8: Full-Flow Single IP vs Poll-Only
async function exp8_fullFlowVsPollOnly() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 8: Full-Flow vs Poll-Only');
  console.log(`Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  const ipA = getIP(5); // Full-flow
  const ipB = getIP(8); // Poll-only

  const rate = 3;
  const duration = 10;

  // Stream A: Full-flow — login + page load + poll all from same IP
  console.log(`\n  STREAM A: Full-flow via ${ipA.label}`);
  console.log(`  Step 1: Login via proxy...`);
  let sessionA: SessionInfo;
  try {
    sessionA = await loginViaProxy(ipA);
  } catch (e) {
    console.log(`  ✗ Login via proxy failed: ${e instanceof Error ? e.message : e}`);
    console.log(`  Falling back to direct login for stream A`);
    sessionA = await loginDirect();
  }

  console.log(`  Step 2: Poll days.json at ${rate}/min × ${duration}min`);
  await rateLoop({
    experiment: 8, stream: 'A-full', ip: ipA,
    url: DAYS_URL, headers: ajaxHeaders(sessionA), headersLabel: 'ajax_auth',
    authenticated: true, ratePerMin: rate, durationMin: duration,
  });

  // Cooldown
  console.log('\n  Waiting 10min cooldown before stream B...');
  await sleep(600000);

  // Stream B: Poll-only — login from direct, poll from proxy
  console.log(`\n  STREAM B: Poll-only via ${ipB.label}`);
  console.log(`  Step 1: Login (direct)...`);
  const sessionB = await loginDirect();

  console.log(`  Step 2: Poll days.json at ${rate}/min × ${duration}min (cross-IP session)`);
  await rateLoop({
    experiment: 8, stream: 'B-poll', ip: ipB,
    url: DAYS_URL, headers: ajaxHeaders(sessionB), headersLabel: 'ajax_auth',
    authenticated: true, ratePerMin: rate, durationMin: duration,
  });
}

// Exp 8b: Full-Flow Sustained Polling (post Exp 8)
async function exp8b_fullFlowRamp() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 8b: Full-Flow Sustained Ramp');
  console.log(`Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  const ip = getIP(5);

  // Login via proxy for full-flow
  console.log(`\n  Login via proxy ${ip.label}...`);
  let session: SessionInfo;
  try {
    session = await loginViaProxy(ip);
  } catch (e) {
    console.log(`  ✗ Proxy login failed, falling back to direct`);
    session = await loginDirect();
  }

  const phases = [
    { rate: 4, min: 5 },
    { rate: 6, min: 5 },
    { rate: 10, min: 5 },
  ];

  for (let p = 0; p < phases.length; p++) {
    const phase = phases[p]!;
    console.log(`\n  Phase ${p + 1}: ${phase.rate}/min × ${phase.min}min`);

    const results = await rateLoop({
      experiment: 8, stream: `8b-p${p + 1}`, ip,
      url: DAYS_URL, headers: ajaxHeaders(session), headersLabel: 'ajax_auth',
      authenticated: true, ratePerMin: phase.rate, durationMin: phase.min,
    });

    const blocked = results.filter((r) => r.status !== 'ok').length;
    if (blocked > results.length * 0.5) {
      console.log(`  ✗ >50% blocked at ${phase.rate}/min — stopping ramp`);
      break;
    }
  }
}

// Exp 9: days.json Rate Ramp — authenticated, single IP
async function exp9_daysJsonRateRamp() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 9: days.json Rate Ramp — authenticated, single IP');
  console.log(`IP: #9 Madrid | Target: days.json (authenticated) | Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  console.log('\n  Logging in (direct) for authenticated session...');
  const session = await loginDirect();
  console.log(`  ✓ Session obtained (cookie ${session.cookie.length} chars)`);

  const ip = getIP(9);
  const phases = [
    { rate: 3,  min: 5 },
    { rate: 4,  min: 5 },
    { rate: 6,  min: 5 },
    { rate: 8,  min: 5 },
    { rate: 10, min: 5 },
    { rate: 15, min: 5 },
    { rate: 20, min: 5 },
  ];

  let totalSent = 0;
  let firstBlockPhase: number | null = null;
  let maxSafeRate = 0;

  for (let p = 0; p < phases.length; p++) {
    const phase = phases[p]!;
    console.log(`\n  Phase ${p + 1}: ${phase.rate}/min × ${phase.min}min (cumulative: ~${totalSent} sent)`);

    const results = await rateLoop({
      experiment: 9,
      phase: p + 1,
      ip,
      url: DAYS_URL,
      headers: ajaxHeaders(session),
      headersLabel: 'ajax_auth',
      authenticated: true,
      ratePerMin: phase.rate,
      durationMin: phase.min,
    });

    const ok = results.filter((r) => r.status === 'ok').length;
    const blocked = results.filter((r) => r.status !== 'ok').length;
    totalSent += results.length;

    console.log(`  Phase ${p + 1} summary: ${ok} ok, ${blocked} blocked (total sent: ${totalSent})`);

    if (blocked === 0) {
      maxSafeRate = phase.rate;
    }

    if (blocked > 0 && firstBlockPhase === null) {
      firstBlockPhase = p + 1;
      console.log(`  ⚠ First block in phase ${p + 1} at rate ${phase.rate}/min`);
    }

    if (blocked > results.length * 0.7) {
      console.log(`  ✗ >70% blocked — stopping ramp`);
      break;
    }
  }

  console.log(`\n  RESULT: Max safe rate = ${maxSafeRate}/min, first block at phase ${firstBlockPhase ?? 'none'}, total requests: ${totalSent}`);
}

// Exp 10: Multi-IP Sustained — 5 IPs round-robin, days.json authenticated
async function exp10_multiIpSustained() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 10: Multi-IP Sustained — 5 IPs round-robin, days.json');
  console.log(`IPs: #1,#4,#5,#9,#10 | Target: days.json (authenticated) | Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  console.log('\n  Logging in (direct) for shared session...');
  const session = await loginDirect();
  console.log(`  ✓ Session obtained`);

  const ips = [getIP(1), getIP(4), getIP(5), getIP(9), getIP(10)];
  const headers = ajaxHeaders(session);

  const phases = [
    { totalRate: 10, durationMin: 10 }, // 2/IP/min
    { totalRate: 20, durationMin: 10 }, // 4/IP/min
    { totalRate: 30, durationMin: 10 }, // 6/IP/min
  ];

  // Track per-IP stats
  const ipStats = new Map<string, { ok: number; blocked: number; error: number; totalLatency: number }>();
  for (const ip of ips) {
    ipStats.set(ip.label, { ok: 0, blocked: 0, error: 0, totalLatency: 0 });
  }

  let totalSent = 0;

  for (let p = 0; p < phases.length; p++) {
    const phase = phases[p]!;
    const ratePerIp = phase.totalRate / ips.length;
    const intervalMs = (60 / phase.totalRate) * 1000;
    const totalRequests = Math.ceil(phase.totalRate * phase.durationMin);

    console.log(`\n  Phase ${p + 1}: ${phase.totalRate}/min total (${ratePerIp}/IP) × ${phase.durationMin}min = ~${totalRequests} req (interval ${Math.round(intervalMs)}ms)`);

    let phaseBlocked = 0;

    for (let i = 0; i < totalRequests; i++) {
      const ip = ips[i % ips.length]!; // strict round-robin
      totalSent++;

      const r = await probe({
        experiment: 10,
        stream: `p${p + 1}`,
        phase: p + 1,
        ip,
        url: DAYS_URL,
        headers,
        headersLabel: 'ajax_auth',
        authenticated: true,
        reqNum: totalSent,
      });

      const stats = ipStats.get(ip.label)!;
      if (r.status === 'ok') stats.ok++;
      else if (r.status === 'blocked') { stats.blocked++; phaseBlocked++; }
      else { stats.error++; phaseBlocked++; }
      stats.totalLatency += r.latencyMs;

      if (i < totalRequests - 1) await sleep(intervalMs);
    }

    // Per-phase summary
    console.log(`\n  Phase ${p + 1} summary: ${phaseBlocked} non-ok out of ${totalRequests}`);
    for (const ip of ips) {
      const s = ipStats.get(ip.label)!;
      const total = s.ok + s.blocked + s.error;
      const avg = total > 0 ? Math.round(s.totalLatency / total) : 0;
      console.log(`    ${ip.label}: ${s.ok} ok, ${s.blocked} blocked, ${s.error} error, avg ${avg}ms`);
    }

    if (phaseBlocked > totalRequests * 0.5) {
      console.log(`  ✗ >50% blocked at ${phase.totalRate}/min total — stopping`);
      break;
    }
  }

  console.log(`\n  FINAL per-IP stats (total ${totalSent} requests):`);
  for (const ip of ips) {
    const s = ipStats.get(ip.label)!;
    const total = s.ok + s.blocked + s.error;
    const avg = total > 0 ? Math.round(s.totalLatency / total) : 0;
    const rate = total > 0 ? ((s.ok / total) * 100).toFixed(1) : '0';
    console.log(`    ${ip.label}: ${total} total, ${s.ok} ok (${rate}%), ${s.blocked} blocked, avg ${avg}ms`);
  }
}

// Exp 11: Peru Endpoint — es-pe vs es-co, same IP
async function exp11_peruEndpoint() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 11: Peru Endpoint — es-pe vs es-co, same IP');
  console.log(`IP: #5 LA | Target: sign_in (public) | Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  const ip = getIP(5);
  const rate = 3;
  const duration = 8;

  const PERU_SIGN_IN = 'https://ais.usvisa-info.com/es-pe/niv/users/sign_in';
  const COLOMBIA_SIGN_IN = 'https://ais.usvisa-info.com/es-co/niv/users/sign_in';

  // Stream A: Peru
  console.log(`\n  STREAM A: es-pe/niv/users/sign_in at ${rate}/min × ${duration}min`);
  const peruResults = await rateLoop({
    experiment: 11,
    stream: 'A-pe',
    ip,
    url: PERU_SIGN_IN,
    headers: fullBrowserHeaders(),
    headersLabel: 'full_browser',
    authenticated: false,
    ratePerMin: rate,
    durationMin: duration,
  });

  const peruOk = peruResults.filter((r) => r.status === 'ok').length;
  const peruBlocked = peruResults.filter((r) => r.status !== 'ok').length;
  console.log(`\n  Peru: ${peruOk} ok, ${peruBlocked} blocked out of ${peruResults.length}`);

  // Brief cooldown
  console.log(`\n  Cooldown 2 min before Colombia stream...`);
  await sleep(120000);

  // Stream B: Colombia
  console.log(`\n  STREAM B: es-co/niv/users/sign_in at ${rate}/min × ${duration}min`);
  const coResults = await rateLoop({
    experiment: 11,
    stream: 'B-co',
    ip,
    url: COLOMBIA_SIGN_IN,
    headers: fullBrowserHeaders(),
    headersLabel: 'full_browser',
    authenticated: false,
    ratePerMin: rate,
    durationMin: duration,
  });

  const coOk = coResults.filter((r) => r.status === 'ok').length;
  const coBlocked = coResults.filter((r) => r.status !== 'ok').length;
  console.log(`\n  Colombia: ${coOk} ok, ${coBlocked} blocked out of ${coResults.length}`);

  console.log(`\n  RESULT: Peru ${peruOk}/${peruResults.length} ok (${((peruOk / peruResults.length) * 100).toFixed(1)}%) vs Colombia ${coOk}/${coResults.length} ok (${((coOk / coResults.length) * 100).toFixed(1)}%)`);
  if (peruBlocked > peruResults.length * 0.1 && coBlocked === 0) {
    console.log('  → Peru endpoint appears more sensitive than Colombia');
  } else if (Math.abs(peruBlocked - coBlocked) <= 1) {
    console.log('  → Both endpoints behave similarly — Bot 7 tcp_blocked is Webshare instability');
  } else {
    console.log('  → Mixed results — needs further investigation');
  }
}

// Exp 12: POST via Webshare — safe dry-run with invalid date
async function exp12_postViaWebshare() {
  console.log('\n' + '='.repeat(80));
  console.log('EXP 12: POST via Webshare — safe dry-run (2099-01-01)');
  console.log(`IP: #4 Dallas | Target: POST /appointment | Started: ${bogotaTime()} Bogota`);
  console.log('='.repeat(80));

  // Login direct to get session + authenticity_token
  console.log('\n  Logging in (direct) for session + authenticity_token...');
  const session = await loginDirect();
  console.log(`  ✓ Session obtained`);

  // We need authenticity_token from the appointment page (loginDirect gets it via step 3)
  // Re-fetch appointment page to get the authenticity_token
  const qs = APPLICANT_IDS.map((id) => `applicants[]=${id}`).join('&');
  const apptUrl = `${BASE_URL}/schedule/${SCHEDULE_ID}/appointment?${qs}&confirmed_limit_message=1&commit=Continuar`;

  const apptResp = await fetch(apptUrl, {
    headers: {
      Cookie: `_yatri_session=${session.cookie}`,
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
    },
    redirect: 'manual',
  });

  if (apptResp.status !== 200) {
    console.log(`  ✗ Appointment page returned ${apptResp.status} — cannot extract authenticity_token`);
    return;
  }

  const apptHtml = await apptResp.text();
  const authMatch = apptHtml.match(/<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/);
  if (!authMatch?.[1]) {
    console.log('  ✗ authenticity_token not found in appointment page');
    return;
  }

  const authenticityToken = authMatch[1];
  const csrfMatch = apptHtml.match(/<meta name="csrf-token" content="([^"]+)"/);
  const csrfToken = csrfMatch?.[1] ?? session.csrf;

  // Update cookie from response
  let cookie = session.cookie;
  for (const h of apptResp.headers.getSetCookie()) {
    const m = h.match(/_yatri_session=([^;]+)/);
    if (m?.[1]) { cookie = m[1]; break; }
  }

  console.log(`  ✓ authenticity_token: ${authenticityToken.substring(0, 20)}...`);
  console.log(`  ✓ csrf-token: ${csrfToken.substring(0, 20)}...`);

  // Build POST body with intentionally invalid date (2099-01-01) — server will reject without moving appointment
  const body = new URLSearchParams({
    authenticity_token: authenticityToken,
    confirmed_limit_message: '1',
    use_consulate_appointment_capacity: 'true',
    'appointments[consulate_appointment][facility_id]': FACILITY_ID,
    'appointments[consulate_appointment][date]': '2099-01-01',
    'appointments[consulate_appointment][time]': '08:00',
    'appointments[asc_appointment][facility_id]': '26',
    'appointments[asc_appointment][date]': '2099-01-01',
    'appointments[asc_appointment][time]': '10:00',
    commit: 'Reprogramar',
  });

  const ip = getIP(4);
  const pUrl = proxyUrl(ip);

  console.log(`\n  Sending POST via ${ip.label} with date 2099-01-01 (invalid)...`);
  const agent = new ProxyAgent({ uri: pUrl });
  const start = Date.now();

  try {
    const resp = await fetch(`${BASE_URL}/schedule/${SCHEDULE_ID}/appointment`, {
      method: 'POST',
      headers: {
        Cookie: `_yatri_session=${cookie}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': csrfToken,
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${BASE_URL}/schedule/${SCHEDULE_ID}/appointment`,
        Origin: 'https://ais.usvisa-info.com',
        'Upgrade-Insecure-Requests': '1',
        ...BROWSER_HEADERS,
      },
      // @ts-expect-error undici dispatcher
      dispatcher: agent,
      signal: AbortSignal.timeout(20000),
      redirect: 'manual',
      body: body.toString(),
    });

    const latencyMs = Date.now() - start;
    const respBody = await resp.text();
    const location = resp.headers.get('location') ?? '(none)';

    console.log(`  Response: HTTP ${resp.status} | Location: ${location} | ${latencyMs}ms`);
    console.log(`  Body (first 200 chars): ${respBody.substring(0, 200).replace(/\n/g, ' ')}`);

    if (resp.status === 402) {
      console.log('\n  RESULT: Webshare proxy blocks POST with HTTP 402 (same as Bright Data)');
    } else if (resp.status === 302 && location.includes('sign_in')) {
      console.log('\n  RESULT: POST returned 302 → sign_in. Session issue via proxy, but proxy itself allowed the POST.');
    } else if (resp.status === 302 && (location.includes('appointment') || location.includes('continue'))) {
      console.log('\n  RESULT: POST went through via Webshare! Server processed it (likely rejected invalid date gracefully).');
    } else if (resp.status === 200 || resp.status === 422) {
      console.log('\n  RESULT: POST went through via Webshare. Server returned error for invalid date — POST works!');
    } else {
      console.log(`\n  RESULT: Unexpected response. POST via Webshare returned HTTP ${resp.status}.`);
    }

    logResult({
      timestamp: now(),
      experiment: 12,
      ip: ip.ip,
      target: 'appointment',
      headers: 'full_post',
      authenticated: true,
      httpStatus: resp.status,
      status: resp.status === 402 ? 'blocked' : 'ok',
      latencyMs,
      bodySnippet: respBody.substring(0, 100),
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ Error: ${msg} (${latencyMs}ms)`);

    logResult({
      timestamp: now(),
      experiment: 12,
      ip: ip.ip,
      target: 'appointment',
      headers: 'full_post',
      authenticated: true,
      status: 'error',
      latencyMs,
      error: msg.substring(0, 120),
    });
  } finally {
    await agent.close().catch(() => {});
  }
}

// ── Summary ────────────────────────────────────────────────────

function printSummary() {
  console.log('\n' + '='.repeat(80));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(80));

  // Group by experiment
  const byExp = new Map<number, ProbeResult[]>();
  for (const r of allResults) {
    const list = byExp.get(r.experiment) ?? [];
    list.push(r);
    byExp.set(r.experiment, list);
  }

  for (const [exp, results] of byExp) {
    const ok = results.filter((r) => r.status === 'ok').length;
    const blocked = results.filter((r) => r.status === 'blocked').length;
    const timeout = results.filter((r) => r.status === 'timeout').length;
    const errors = results.filter((r) => r.status === 'error').length;
    const avgLatency = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length);

    console.log(
      `  Exp ${exp}: ${results.length} total | ${ok} ok | ${blocked} blocked | ${timeout} timeout | ${errors} error | avg ${avgLatency}ms`,
    );

    // Per-stream breakdown
    const streams = [...new Set(results.map((r) => r.stream).filter(Boolean))];
    for (const stream of streams) {
      const sr = results.filter((r) => r.stream === stream);
      const sOk = sr.filter((r) => r.status === 'ok').length;
      const sBlocked = sr.filter((r) => r.status !== 'ok').length;
      console.log(`    Stream ${stream}: ${sOk} ok, ${sBlocked} blocked`);
    }
  }

  // JSON dump for analysis
  console.log('\n--- JSON RESULTS (pipe to file for analysis) ---');
  for (const r of allResults) {
    console.log(JSON.stringify(r));
  }
}

// ── Main ───────────────────────────────────────────────────────

const EXPERIMENTS: Record<string, () => Promise<void>> = {
  '1': exp1_rateRamp,
  '2': exp2_endpointSensitivity,
  '3': exp3_headerSensitivity,
  '4': exp4_crossIpSession,
  '5': exp5_recovery,
  '6': exp6_dcVsResidential,
  '7': exp7_subnetBlocking,
  '8': exp8_fullFlowVsPollOnly,
  '8b': exp8b_fullFlowRamp,
  '9': exp9_daysJsonRateRamp,
  '10': exp10_multiIpSustained,
  '11': exp11_peruEndpoint,
  '12': exp12_postViaWebshare,
};

const args = process.argv.slice(2);
const expArg = args.find((a) => a.startsWith('--exp='))?.split('=')[1];

if (!expArg) {
  console.log('Usage: npx tsx --env-file=.env scripts/blocking-experiments.ts --exp=<N>');
  console.log('  --exp=1       Run experiment 1');
  console.log('  --exp=1,2,3   Run experiments 1, 2, 3 sequentially');
  console.log('  --exp=all     Run all experiments in recommended order');
  console.log('\nExperiments:');
  console.log('  1  Rate Ramp (sign_in public, ~35min)');
  console.log('  2  Endpoint Sensitivity (sign_in vs days.json, ~25min)');
  console.log('  3  Header Sensitivity (~25min)');
  console.log('  4  Cross-IP Session Sharing (~15min)');
  console.log('  5  Recovery Time (~50min)');
  console.log('  6  DC vs Residential (~20min)');
  console.log('  7  Subnet Blocking (~20min)');
  console.log('  8  Full-Flow vs Poll-Only (~25min)');
  console.log('  8b Full-Flow Sustained Ramp (~30min)');
  console.log('  9  days.json Rate Ramp — authenticated single IP (~40min)');
  console.log('  10 Multi-IP Sustained — 5 IPs round-robin days.json (~30min)');
  console.log('  11 Peru Endpoint — es-pe vs es-co same IP (~20min)');
  console.log('  12 POST via Webshare — safe dry-run (~2min)');
  process.exit(0);
}

const expList =
  expArg === 'all'
    ? ['1', '8', '2', '3', '7', '4', '5', '6', '8b', '11', '9', '10', '12'] // recommended order
    : expArg.split(',').map((s) => s.trim());

console.log(`Blocking Experiments — ${expList.join(', ')}`);
console.log(`Started: ${bogotaTime()} Bogota\n`);

for (let i = 0; i < expList.length; i++) {
  const expId = expList[i]!;
  const fn = EXPERIMENTS[expId];
  if (!fn) {
    console.error(`Unknown experiment: ${expId}`);
    continue;
  }

  await fn();

  // Cooldown between experiments
  if (i < expList.length - 1) {
    console.log(`\n  ⏳ Cooldown 10 min before next experiment...`);
    await sleep(600000);
  }
}

printSummary();
process.exit(0);
