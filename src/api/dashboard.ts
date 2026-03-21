import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { createHmac } from 'node:crypto';

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '1004232331';
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'visa-bot-dashboard-hmac-key';
const AUTH_COOKIE = 'dashboard_auth';

export function computeAuthToken(): string {
  return createHmac('sha256', COOKIE_SECRET).update(DASHBOARD_PASSWORD).digest('hex');
}

export const dashboardRouter = new Hono();

// Login POST
dashboardRouter.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const password = String(body.password || '');
  if (password !== DASHBOARD_PASSWORD) {
    return c.html(renderLoginPage('Contraseña incorrecta'));
  }
  setCookie(c, AUTH_COOKIE, computeAuthToken(), {
    path: '/',
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60, // 30 days
    sameSite: 'Lax',
  });
  return c.redirect('/dashboard');
});

// Auth middleware — must be AFTER /login but BEFORE all other routes
dashboardRouter.use('*', async (c, next) => {
  // Skip auth check for POST /login (already handled above)
  if (c.req.method === 'POST' && c.req.path.endsWith('/login')) return next();
  const token = getCookie(c, AUTH_COOKIE);
  if (token !== computeAuthToken()) {
    return c.html(renderLoginPage());
  }
  return next();
});

dashboardRouter.get('/', (c) => c.html(renderLanding()));

dashboardRouter.get('/:botId', async (c) => {
  const raw = c.req.param('botId');
  const botId = parseInt(raw, 10);
  if (isNaN(botId)) return c.text('Invalid bot ID', 400);
  const webshareIps = await fetchAllWebshareIps();
  return c.html(renderDashboard(String(botId), webshareIps));
});

// ── Login page ────────────────────────────────────────────
function renderLoginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<meta name="theme-color" content="#0C0C0E">
<title>Visa Bot — Login</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0C0C0E;--surface:#161618;--border:rgba(255,255,255,0.06);
  --text:#A0A0AB;--bright:#E4E4E9;--muted:#5A5A65;
  --accent:#A78BFA;--accent-dim:rgba(167,139,250,0.08);--accent-border:rgba(167,139,250,0.15);
  --red:#F87171;
}
body{font-family:'JetBrains Mono',monospace;background:var(--bg);color:var(--text);
  display:flex;align-items:center;justify-content:center;min-height:100vh;
  -webkit-font-smoothing:antialiased}
.login-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;
  padding:32px 28px;width:100%;max-width:340px;text-align:center}
.login-title{font-size:18px;font-weight:800;color:var(--bright);letter-spacing:.5px;margin-bottom:4px}
.login-title span{color:var(--accent)}
.login-sub{font-size:11px;color:var(--muted);margin-bottom:24px}
.login-input{width:100%;padding:10px 14px;font-family:inherit;font-size:14px;
  background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--bright);
  outline:none;text-align:center;letter-spacing:2px;margin-bottom:12px}
.login-input:focus{border-color:var(--accent-border)}
.login-input::placeholder{color:var(--muted);letter-spacing:0}
.login-btn{width:100%;padding:10px;font-family:inherit;font-size:12px;font-weight:700;
  text-transform:uppercase;letter-spacing:1px;cursor:pointer;
  background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent-border);
  border-radius:8px;transition:all .15s}
.login-btn:hover{background:rgba(167,139,250,0.15)}
.login-err{font-size:11px;color:var(--red);margin-bottom:12px}
</style>
</head>
<body>
<form class="login-box" method="POST" action="/dashboard/login">
  <div class="login-title">visa bot<span>_</span></div>
  <div class="login-sub">ingresa el código de acceso</div>
  ${error ? `<div class="login-err">${error}</div>` : ''}
  <input class="login-input" type="password" name="password" placeholder="código" autofocus autocomplete="off">
  <button class="login-btn" type="submit">entrar</button>
</form>
</body>
</html>`;
}

// ── Webshare IP list (cached 5min) ─────────────────────────
let _webshareIpsCache: { ips: string[]; ts: number } | null = null;

async function fetchAllWebshareIps(): Promise<string[]> {
  if (_webshareIpsCache && Date.now() - _webshareIpsCache.ts < 5 * 60 * 1000) {
    return _webshareIpsCache.ips;
  }

  const apiKey = process.env.WEBSHARE_API_KEY;
  if (!apiKey) return [];

  try {
    const resp = await fetch('https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100', {
      headers: { Authorization: `Token ${apiKey}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return [];
    const json = await resp.json() as { results: { proxy_address: string; valid: boolean }[] };
    const ips = json.results.filter(p => p.valid).map(p => p.proxy_address);
    _webshareIpsCache = { ips, ts: Date.now() };
    return ips;
  } catch {
    return _webshareIpsCache?.ips ?? [];
  }
}

// ── Country metadata ──────────────────────────────────────
const COUNTRY_META: Record<string, { flag: string; name: string }> = {
  co: { flag: '🇨🇴', name: 'Colombia' },
  pe: { flag: '🇵🇪', name: 'Perú' },
  mx: { flag: '🇲🇽', name: 'México' },
  ca: { flag: '🇨🇦', name: 'Canadá' },
  am: { flag: '🇦🇲', name: 'Armenia' },
  ar: { flag: '🇦🇷', name: 'Argentina' },
  br: { flag: '🇧🇷', name: 'Brasil' },
  cl: { flag: '🇨🇱', name: 'Chile' },
  ec: { flag: '🇪🇨', name: 'Ecuador' },
  gt: { flag: '🇬🇹', name: 'Guatemala' },
  jm: { flag: '🇯🇲', name: 'Jamaica' },
  pa: { flag: '🇵🇦', name: 'Panamá' },
  do: { flag: '🇩🇴', name: 'Rep. Dominicana' },
  tt: { flag: '🇹🇹', name: 'Trinidad y Tobago' },
  uy: { flag: '🇺🇾', name: 'Uruguay' },
  ve: { flag: '🇻🇪', name: 'Venezuela' },
};

function getCountryFromLocale(locale: string): { code: string; flag: string; name: string } {
  const cc = locale.split('-')[1] || 'xx';
  const meta = COUNTRY_META[cc];
  return { code: cc, flag: meta?.flag || '🏳️', name: meta?.name || cc.toUpperCase() };
}

// ── Landing page ──────────────────────────────────────────
function renderLanding(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<meta name="theme-color" content="#0C0C0E">
<meta name="mobile-web-app-capable" content="yes">
<title>Visa Bot — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0C0C0E;--surface:#161618;--surface2:#1C1C1F;--border:rgba(255,255,255,0.06);
  --text:#A0A0AB;--bright:#E4E4E9;--dim:#3A3A42;--muted:#5A5A65;
  --accent:#A78BFA;--accent-dim:rgba(167,139,250,0.08);--accent-border:rgba(167,139,250,0.15);
  --red:#F87171;--green:#4ADE80;--amber:#FCD34D;--cyan:#67E8F9;--blue:#60A5FA;
}
body{font-family:'JetBrains Mono',monospace;background:var(--bg);color:var(--text);
  max-width:540px;margin:0 auto;padding:16px 14px;font-size:12px;line-height:1.5;
  -webkit-font-smoothing:antialiased;min-height:100vh}

.hdr{display:flex;justify-content:space-between;align-items:baseline;padding:2px 0 12px}
.hdr-title{font-size:17px;font-weight:800;color:var(--bright);letter-spacing:.5px}
.hdr-title span{color:var(--accent)}
.cursor{animation:blink 1s step-end infinite;color:var(--muted)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.hdr-clock{font-size:11px;color:var(--muted)}

.country-group{margin-bottom:16px}
.country-hdr{display:flex;align-items:center;gap:8px;padding:8px 0 6px;border-bottom:1px solid var(--border);margin-bottom:8px}
.country-flag{font-size:20px;line-height:1}
.country-name{font-size:13px;font-weight:800;color:var(--bright);text-transform:uppercase;letter-spacing:1px}
.country-count{font-size:10px;color:var(--muted);margin-left:auto}

.bot-card{display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:6px;
  background:var(--surface);border:1px solid var(--border);border-radius:8px;
  cursor:pointer;-webkit-tap-highlight-color:transparent;transition:border-color .15s,background .15s;
  text-decoration:none;color:inherit}
.bot-card:hover,.bot-card:active{border-color:var(--accent-border);background:var(--accent-dim)}

.bot-id{font-size:14px;font-weight:800;color:var(--accent);min-width:32px}
.bot-info{flex:1;min-width:0}
.bot-appt{font-size:13px;font-weight:700;color:var(--bright);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bot-appt-none{color:var(--dim);font-style:italic;font-weight:400}
.bot-meta{font-size:9px;color:var(--muted);margin-top:2px;display:flex;gap:8px;flex-wrap:wrap}
.bot-events{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}
.ev-pill{font-size:9px;font-weight:600;padding:1px 6px;border-radius:3px;letter-spacing:.2px;white-space:nowrap}
.ev-ok{background:rgba(74,222,128,.1);color:var(--green);border:1px solid rgba(74,222,128,.2)}
.ev-fail{background:rgba(252,211,77,.08);color:var(--amber);border:1px solid rgba(252,211,77,.2)}
.ev-err{background:rgba(248,113,113,.1);color:var(--red);border:1px solid rgba(248,113,113,.2)}

.chip{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:2px 7px;border-radius:4px;flex-shrink:0}
.chip-active{background:rgba(74,222,128,.1);color:var(--green)}
.chip-paused{background:rgba(252,211,77,.1);color:var(--amber)}
.chip-error{background:rgba(248,113,113,.1);color:var(--red)}
.chip-login_required,.chip-created{background:rgba(96,165,250,.1);color:var(--blue)}

.bot-days{font-size:11px;font-weight:700;color:var(--muted);text-align:right;min-width:36px;flex-shrink:0}
.bot-days .num{font-size:14px;color:var(--bright)}
.bot-days .lbl{font-size:8px;text-transform:uppercase;letter-spacing:.3px}

.summary{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;flex:1;min-width:80px;text-align:center}
.stat-val{font-size:20px;font-weight:800;color:var(--bright)}
.stat-lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-top:2px}

.limits{font-size:9px;color:var(--dim);display:flex;gap:4px;align-items:center}
.limits .bar{flex:1;height:3px;background:var(--dim);border-radius:2px;max-width:40px;overflow:hidden}
.limits .fill{height:100%;border-radius:2px}

.empty-msg{text-align:center;padding:40px 20px;color:var(--muted);font-size:13px}
.foot{font-size:9px;color:var(--dim);text-align:center;padding:12px 0 20px;letter-spacing:.5px}
.sk{background:linear-gradient(90deg,var(--surface) 25%,var(--surface2) 50%,var(--surface) 75%);
  background-size:200%;animation:shimmer 2s infinite;border-radius:4px;height:60px;margin-bottom:6px}
@keyframes shimmer{0%{background-position:200%}100%{background-position:-200%}}

.fh-hdr{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;
  color:var(--muted);margin:14px 0 6px;display:flex;align-items:center;gap:6px}
.fh-hdr::after{content:'';flex:1;height:1px;background:var(--border)}
.fh-row{display:flex;align-items:center;gap:9px;padding:8px 11px;margin-bottom:4px;
  background:var(--surface);border:1px solid var(--border);border-radius:7px}
.fh-bid{font-size:11px;font-weight:800;color:var(--accent);min-width:26px;flex-shrink:0;text-decoration:none;display:flex;flex-direction:column;gap:1px}
.fh-bid:hover{text-decoration:underline}
.fh-owner{font-size:9px;font-weight:400;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70px}
.fh-phone{font-size:8px;font-weight:400;color:var(--green);white-space:nowrap}
.fh-bar-wrap{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.fh-win-row{display:flex;align-items:center;gap:5px}
.fh-win{font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
  color:var(--muted);min-width:16px;flex-shrink:0}
.fh-pct{font-size:10px;font-weight:700;min-width:26px;flex-shrink:0}
.fh-bar{flex:1;height:3px;border-radius:2px;background:var(--dim);overflow:hidden}
.fh-fill{height:100%;border-radius:2px}
.fh-meta{font-size:8px;color:var(--muted);flex-shrink:0;white-space:nowrap}
.fh-rs{font-size:8px;font-weight:600;padding:2px 6px;border-radius:3px;white-space:nowrap;flex-shrink:0;letter-spacing:.2px}
.fh-rs-ok{background:rgba(74,222,128,.1);color:var(--green);border:1px solid rgba(74,222,128,.2)}
.fh-rs-fail{background:rgba(248,113,113,.1);color:var(--red);border:1px solid rgba(248,113,113,.2)}
.fh-rs-none{color:var(--dim);border:1px solid var(--border)}

</style>
</head>
<body>

<div class="hdr">
  <div class="hdr-title">visa bot<span>_</span><span class="cursor">|</span></div>
  <div class="hdr-clock" id="clock">--:--:--</div>
</div>

<div class="summary" id="summary">
  <div class="stat"><div class="stat-val sk" style="height:24px;width:30px;margin:0 auto">&nbsp;</div><div class="stat-lbl">bots</div></div>
  <div class="stat"><div class="stat-val sk" style="height:24px;width:30px;margin:0 auto">&nbsp;</div><div class="stat-lbl">activos</div></div>
  <div class="stat"><div class="stat-val sk" style="height:24px;width:30px;margin:0 auto">&nbsp;</div><div class="stat-lbl">paises</div></div>
</div>

<div id="fleet-health"></div>

<div id="content">
  <div class="sk">&nbsp;</div><div class="sk">&nbsp;</div><div class="sk">&nbsp;</div>
</div>

<div class="foot">visa bot &middot; multi-country dashboard</div>

<script>
var COUNTRIES=${JSON.stringify(COUNTRY_META)};
var TZ={timeZone:'America/Bogota'};

function tickClock(){
  var n=new Date();
  document.getElementById('clock').textContent=n.toLocaleTimeString('es-CO',{...TZ,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}

function cc(locale){return locale?locale.split('-')[1]||'xx':'xx'}
function meta(code){return COUNTRIES[code]||{flag:'\\u{1F3F3}\\uFE0F',name:code.toUpperCase()}}

function fmtD(d){
  if(!d)return null;
  var p=d.split('-'),m=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return parseInt(p[2])+' '+m[parseInt(p[1])-1]+' '+p[0];
}

function daysUntil(d){
  if(!d)return '';
  var ms=new Date(d+'T12:00:00').getTime()-new Date(new Date().toLocaleString('en-US',TZ).replace(',','')).getTime();
  var days=Math.ceil(ms/86400000);
  return days;
}

function fmtEvDate(d){
  if(!d)return '';
  var p=d.split('-');
  var MONTHS=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return parseInt(p[2])+' '+MONTHS[parseInt(p[1])-1];
}

function limitBar(count,max){
  if(max==null)return '';
  var pct=Math.min(100,Math.round(count/max*100));
  var color=pct>=100?'var(--red)':pct>=50?'var(--amber)':'var(--green)';
  return '<span class="limits">'+count+'/'+max+' <span class="bar"><span class="fill" style="width:'+pct+'%;background:'+color+'"></span></span></span>';
}

function renderFleetHealth(bots,health,events,health1h){
  var active=bots.filter(function(b){return b.status==='active';});
  if(!active.length){document.getElementById('fleet-health').innerHTML='';return;}
  active.sort(function(a,b){return a.id-b.id;});
  var html='<div class="fh-hdr">salud</div>';

  function barColor(pct){
    if(pct===null)return'var(--dim)';
    return pct>=80?'var(--green)':pct>=50?'var(--amber)':'var(--red)';
  }

  active.forEach(function(b){
    var p24=health[b.id]||{total:0,ok:0,tcp:0};
    var p1=(health1h&&health1h[b.id])||{total:0,ok:0,tcp:0};

    var pct1=p1.total>0?Math.round(p1.ok/p1.total*100):null;
    var pct24=p24.total>0?Math.round(p24.ok/p24.total*100):null;
    var col1=barColor(pct1);
    var col24=barColor(pct24);

    /* 1h bar */
    var pctTxt1=pct1!==null?'<span style="color:'+col1+'">'+pct1+'%</span>':'<span style="color:var(--dim)">--</span>';
    var meta1=p1.total>0?'<span class="fh-meta">'+p1.total+'p</span>':'<span class="fh-meta" style="color:var(--dim)">sin polls</span>';

    /* 24h bar */
    var pctTxt24=pct24!==null?'<span style="color:'+col24+'">'+pct24+'%</span>':'<span style="color:var(--dim)">--</span>';
    var tcpStr=p24.tcp>0?' <span style="color:var(--red)">'+p24.tcp+' tcp</span>':'';
    var meta24=p24.total>0?'<span class="fh-meta">'+p24.total+'p'+tcpStr+'</span>':'<span class="fh-meta" style="color:var(--dim)">--</span>';

    /* rsPill */
    var ev=events[b.id];
    var rsPill;
    if(ev&&ev.successes&&ev.successes.length>0){
      rsPill='<span class="fh-rs fh-rs-ok">\u2713 '+fmtEvDate(ev.successes[0].date)+'</span>';
    }else if(ev&&ev.failedCount>0){
      rsPill='<span class="fh-rs fh-rs-fail">\u2717 '+ev.failedCount+(ev.failedCount>1?' fallos':' fallo')+'</span>';
    }else{
      rsPill='<span class="fh-rs fh-rs-none">\u2014</span>';
    }

    var ownerTxt=b.ownerEmail?'<span class="fh-owner">'+b.ownerEmail.split('@')[0]+'</span>':'';
    var phoneTxt=b.notificationPhone?'<span class="fh-phone">wa:'+b.notificationPhone.slice(-4)+'</span>':'';
    html+='<div class="fh-row">'
      +'<a href="/dashboard/'+b.id+'" class="fh-bid">#'+b.id+ownerTxt+phoneTxt+'</a>'
      +'<span class="fh-bar-wrap">'
        +'<div class="fh-win-row">'
          +'<span class="fh-win">1h</span>'
          +'<span class="fh-pct">'+pctTxt1+'</span>'
          +'<div class="fh-bar"><div class="fh-fill" style="width:'+(pct1||0)+'%;background:'+col1+'"></div></div>'
          +meta1
        +'</div>'
        +'<div class="fh-win-row">'
          +'<span class="fh-win">24h</span>'
          +'<span class="fh-pct">'+pctTxt24+'</span>'
          +'<div class="fh-bar"><div class="fh-fill" style="width:'+(pct24||0)+'%;background:'+col24+'"></div></div>'
          +meta24
        +'</div>'
      +'</span>'
      +rsPill+'</div>';
  });
  document.getElementById('fleet-health').innerHTML=html;
}

function renderBotList(bots,events){
  var groups={};
  bots.forEach(function(b){
    var code=cc(b.locale);
    if(!groups[code])groups[code]={bots:[],meta:meta(code)};
    groups[code].bots.push(b);
  });
  var sorted=Object.keys(groups).sort(function(a,b){
    var diff=groups[b].bots.length-groups[a].bots.length;
    return diff!==0?diff:groups[a].meta.name.localeCompare(groups[b].meta.name);
  });
  var html='';
  sorted.forEach(function(code){
    var g=groups[code];
    html+='<div class="country-group">';
    html+='<div class="country-hdr">';
    html+='<span class="country-flag">'+g.meta.flag+'</span>';
    html+='<span class="country-name">'+g.meta.name+'</span>';
    html+='<span class="country-count">'+g.bots.length+' bot'+(g.bots.length>1?'s':'')+'</span>';
    html+='</div>';
    g.bots.forEach(function(b){
      var days=daysUntil(b.currentConsularDate);
      var daysColor=days<=7?'var(--red)':days<=30?'var(--amber)':'var(--bright)';
      var apptStr=b.currentConsularDate?fmtD(b.currentConsularDate)+(b.currentConsularTime?' '+b.currentConsularTime:''):'';
      var metaParts=[];
      var envs=(b.pollEnvironments||['dev']);
      metaParts.push(envs.join('+'));
      if(b.ownerEmail){var em=b.ownerEmail.split('@');var short=em[0].length>10?em[0].substring(0,10)+'\u2026':em[0];metaParts.unshift('<span style="color:var(--accent);font-size:9px">'+short+'</span>');}
      if(b.notificationPhone){metaParts.push('<span style="color:var(--green);font-size:9px">wa:'+b.notificationPhone.slice(-4)+'</span>');}
      if(b.consecutiveErrors>0)metaParts.push('<span style="color:var(--red)">'+b.consecutiveErrors+' err</span>');
      if(b.targetDateBefore)metaParts.push('target &lt; '+fmtD(b.targetDateBefore));
      var limitsHtml=limitBar(b.rescheduleCount,b.maxReschedules);
      if(limitsHtml)metaParts.push(limitsHtml);
      var evData=events[b.id];
      var evPills='';
      if(evData){
        if(evData.successes&&evData.successes.length>0){
          var lastOk=evData.successes[0];
          evPills+='<span class="ev-pill ev-ok">\u2713 \u2192 '+fmtEvDate(lastOk.date)+(lastOk.time?' '+lastOk.time:'')+'</span>';
        }
        if(evData.failedCount>0){
          evPills+='<span class="ev-pill ev-fail">\u26a1 '+evData.failedCount+(evData.failedCount===1?' intento fallido':' intentos fallidos')+'</span>';
        }
      }
      if(b.consecutiveErrors>=3){
        evPills+='<span class="ev-pill ev-err">\u2717 '+b.consecutiveErrors+' errores</span>';
      }
      html+='<a class="bot-card" href="/dashboard/'+b.id+'">';
      html+='<span class="bot-id">#'+b.id+'</span>';
      html+='<span class="bot-info">';
      html+='<div class="bot-appt">'+(apptStr||'<span class="bot-appt-none">sin cita</span>')+'</div>';
      html+='<div class="bot-meta">'+metaParts.join(' <span style="color:var(--dim)">&middot;</span> ')+'</div>';
      if(evPills)html+='<div class="bot-events">'+evPills+'</div>';
      html+='</span>';
      html+='<span class="chip chip-'+b.status+'">'+b.status+'</span>';
      if(b.currentConsularDate){
        html+='<span class="bot-days" style="color:'+daysColor+'"><span class="num">'+days+'</span><span class="lbl">d</span></span>';
      }
      html+='</a>';
    });
    html+='</div>';
  });
  document.getElementById('content').innerHTML=html;
}

async function load(){
  try{
    var res=await fetch('/api/bots/landing');
    var data=res.ok?await res.json():{bots:[],events:{},health:{}};
    var bots=data.bots||[];
    var events=data.events||{};
    var health=data.health||{};
    var health1h=data.health1h||{};
    if(!bots.length){
      document.getElementById('content').innerHTML='<div class="empty-msg">no hay bots configurados</div>';
      document.getElementById('summary').innerHTML='';
      document.getElementById('fleet-health').innerHTML='';
      return;
    }
    var active=bots.filter(function(b){return b.status==='active';}).length;
    var countries=new Set(bots.map(function(b){return cc(b.locale);})).size;
    document.getElementById('summary').innerHTML=
      '<div class="stat"><div class="stat-val">'+bots.length+'</div><div class="stat-lbl">bots</div></div>'+
      '<div class="stat"><div class="stat-val">'+active+'</div><div class="stat-lbl">activos</div></div>'+
      '<div class="stat"><div class="stat-val">'+countries+'</div><div class="stat-lbl">paises</div></div>';
    renderFleetHealth(bots,health,events,health1h);
    renderBotList(bots,events);
  }catch(e){
    console.error('fetch error',e);
    document.getElementById('content').innerHTML='<div class="empty-msg">error cargando bots</div>';
  }
}

tickClock();load();
setInterval(tickClock,1000);
setInterval(load,60000);
</script>
</body>
</html>`;
}

function renderDashboard(botId: string, webshareIps: string[] = []): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<meta name="theme-color" content="#0C0C0E">
<meta name="mobile-web-app-capable" content="yes">
<title>Visa Bot #${botId}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0C0C0E;--surface:#161618;--surface2:#1C1C1F;--border:rgba(255,255,255,0.06);
  --text:#A0A0AB;--bright:#E4E4E9;--dim:#3A3A42;--muted:#5A5A65;
  --accent:#A78BFA;--accent-dim:rgba(167,139,250,0.08);--accent-border:rgba(167,139,250,0.15);
  --red:#F87171;--green:#4ADE80;--amber:#FCD34D;--cyan:#67E8F9;
  --blue:#60A5FA;
}
body{font-family:'JetBrains Mono',monospace;background:var(--bg);color:var(--text);
  max-width:480px;margin:0 auto;padding:10px 12px;font-size:12px;line-height:1.5;
  -webkit-font-smoothing:antialiased;min-height:100vh}

/* ── Header ── */
.hdr{display:flex;justify-content:space-between;align-items:baseline;padding:2px 0 6px}
.hdr-title{font-size:15px;font-weight:800;color:var(--bright);letter-spacing:.5px}
.hdr-title span{color:var(--accent)}
.cursor{animation:blink 1s step-end infinite;color:var(--muted)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.hdr-clock{font-size:11px;color:var(--muted)}

/* ── Countdown ── */
.cd-bar{height:2px;background:var(--dim);border-radius:1px;overflow:hidden;margin-bottom:6px}
.cd-fill{height:100%;background:var(--accent);transition:width 1s linear}
.cd-text{font-size:10px;color:var(--muted);text-align:right;margin-bottom:8px}
.cd-text span{color:var(--accent)}

/* ── Status strip ── */
.strip{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;padding:8px 10px;
  background:var(--surface);border:1px solid var(--border);border-radius:8px}
.chip{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:2px 8px;border-radius:4px}
.chip-active{background:rgba(74,222,128,.1);color:var(--green)}
.chip-paused{background:rgba(252,211,77,.1);color:var(--amber)}
.chip-error{background:rgba(248,113,113,.1);color:var(--red)}
.chip-login_required,.chip-created{background:rgba(96,165,250,.1);color:var(--blue)}
.sep{color:var(--dim);font-size:10px}
.strip-val{font-size:11px;font-weight:700}
.strip-lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-right:3px}

/* ── Cards ── */
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.card-t{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);margin-bottom:8px;
  display:flex;align-items:center;justify-content:space-between}

/* ── Appointment ── */
.appt{display:flex;flex-direction:column;gap:6px}
.appt-row{display:flex;justify-content:space-between;align-items:baseline}
.appt-lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;width:70px}
.appt-val{font-size:14px;font-weight:800;color:var(--bright)}
.appt-days{font-size:10px;color:var(--muted);margin-left:6px;font-weight:400}
.appt-cas .appt-val{font-size:12px;color:var(--text);font-weight:700}

/* ── Tabs ── */
.tabs{display:flex;gap:2px;margin-bottom:8px}
.tab{flex:1;padding:7px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;
  letter-spacing:1px;cursor:pointer;-webkit-tap-highlight-color:transparent;color:var(--muted);
  border:1px solid transparent;border-radius:6px;transition:all .15s}
.tab.on{color:var(--accent);border-color:var(--accent-border);background:var(--accent-dim)}
.tab-c{display:none}.tab-c.on{display:block}

/* ── Chart ── */
.chart-wrap{position:relative;height:155px;margin:4px 0}
.chart-wrap canvas{width:100%;height:100%;display:block}
.chart-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:11px;color:var(--dim)}

/* ── Table ── */
table{width:100%;border-collapse:collapse;font-size:11px}
th{text-align:left;color:var(--muted);font-weight:400;font-size:9px;text-transform:uppercase;
  letter-spacing:.5px;padding:4px 3px;border-bottom:1px solid var(--border)}
td{padding:4px 3px;border-bottom:1px solid var(--border);white-space:nowrap}

/* ── Badges ── */
.b{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;text-transform:uppercase;letter-spacing:.3px}
.b-ok{background:rgba(74,222,128,.1);color:var(--green)}
.b-filtered_out{background:rgba(255,255,255,.04);color:var(--muted)}
.b-soft_ban{background:rgba(252,211,77,.1);color:var(--amber)}
.b-tcp_blocked,.b-econnrefused{background:rgba(248,113,113,.1);color:var(--red)}
.b-tcp_embassy{background:rgba(248,113,113,.1);color:var(--red)}
.b-tcp_drop{background:rgba(248,113,113,.28);color:#ff4d4d;font-weight:700}
.b-tcp_quota{background:rgba(252,211,77,.12);color:var(--amber)}
.b-tcp_infra{background:rgba(251,146,60,.1);color:#f97316}
.b-error,.b-session_expired{background:rgba(248,113,113,.08);color:var(--red)}
.b-success{background:rgba(74,222,128,.1);color:var(--green)}
.b-fail{background:rgba(248,113,113,.1);color:var(--red)}

/* ── Poll latest ── */
.poll-latest{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px}
.pl-item{display:flex;justify-content:space-between;align-items:baseline;padding:3px 0}
.pl-lbl{font-size:9px;color:var(--muted);text-transform:uppercase}
.pl-val{font-size:11px;font-weight:700}

/* ── Collapsible ── */
.coll-hdr{cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none}
.coll-hdr::after{content:'\\25BE';font-size:9px;color:var(--dim);margin-left:4px}
.collapsed .coll-hdr::after{content:'\\25B8'}
.collapsed .coll-body{display:none}

/* ── Reschedules ── */
.rs-item{padding:6px 0;border-bottom:1px solid var(--border)}
.rs-item:last-child{border-bottom:none}
.rs-dates{font-size:12px}
.rs-arrow{color:var(--dim);margin:0 4px}
.rs-meta{font-size:10px;color:var(--muted);margin-top:2px}
.rs-err{color:var(--red);font-size:10px}

/* ── Actions ── */
.actions{display:flex;gap:6px;margin-top:8px}
.btn{flex:1;padding:8px;border:none;border-radius:6px;font-family:inherit;font-size:11px;
  font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:opacity .15s;
  text-transform:uppercase;letter-spacing:.5px;min-height:38px}
.btn:active{opacity:.6}
.btn:disabled{opacity:.3;cursor:not-allowed}
.btn-g{background:rgba(74,222,128,.1);color:var(--green);border:1px solid rgba(74,222,128,.2)}
.btn-r{background:rgba(248,113,113,.1);color:var(--red);border:1px solid rgba(248,113,113,.2)}
.btn-c{background:rgba(96,165,250,.1);color:var(--blue);border:1px solid rgba(96,165,250,.2)}
.btn-w{background:rgba(252,211,77,.08);color:var(--amber);border:1px solid rgba(252,211,77,.2)}
.emerg-lbl{font-size:8px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;width:100%;margin-top:2px}

/* ── CAS Heatmap ── */
.hm{margin:4px 0}
.hm-summary{display:flex;gap:10px;font-size:10px;margin-bottom:8px;flex-wrap:wrap}
.hm-summary span{display:flex;align-items:center;gap:3px}
.hm-grid{display:grid;grid-template-columns:44px repeat(11,1fr);gap:1px}
.hm-corner{font-size:8px;color:var(--dim)}
.hm-hour{font-size:8px;color:var(--muted);text-align:center;padding:2px 0}
.hm-lbl{font-size:9px;color:var(--muted);display:flex;align-items:center;height:14px;padding-right:3px}
.hm-lbl.sun{color:rgba(248,113,113,.5)}
.hm-cell{height:14px;border-radius:2px}
.hm-c-none{background:rgba(255,255,255,.02)}
.hm-c-full{background:rgba(248,113,113,.15)}
.hm-c-err{background:rgba(255,255,255,.03)}
.hm-c-0{background:rgba(96,165,250,.04)}
.hm-legend{display:flex;gap:10px;margin-top:8px;font-size:8px;color:var(--muted);justify-content:center}
.hm-sw{display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:middle;margin-right:2px}

/* ── Toast ── */
.toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:6px;
  font-family:inherit;font-size:11px;font-weight:700;z-index:100;opacity:0;transition:opacity .3s;
  pointer-events:none;max-width:calc(100vw - 32px);text-align:center;letter-spacing:.3px}
.toast.show{opacity:1}
.toast-ok{background:rgba(74,222,128,.9);color:#000}
.toast-err{background:rgba(248,113,113,.9);color:#fff}

/* ── CAS Changes ── */
.chg-item{display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);font-size:11px;flex-wrap:wrap}
.chg-item:last-child{border-bottom:none}
.chg-date{color:var(--muted);font-size:10px;min-width:50px}
.chg-dow{color:var(--dim);font-size:9px;min-width:24px}
.chg-badge{font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;text-transform:uppercase;letter-spacing:.3px}
.chg-appeared{background:rgba(74,222,128,.12);color:var(--green)}
.chg-went_full{background:rgba(248,113,113,.12);color:var(--red)}
.chg-disappeared{background:rgba(255,255,255,.06);color:var(--muted)}
.chg-slots{font-size:10px;color:var(--text)}
.chg-arrow{color:var(--dim);margin:0 2px;font-size:9px}
.chg-time{font-size:9px;color:var(--dim);margin-left:auto}
.chg-slots_changed{background:rgba(96,165,250,.12);color:#60a5fa}
.chg-times{font-size:8px;color:var(--dim);margin-top:2px;line-height:1.5;width:100%;padding-left:50px}
.chg-t-add{color:var(--green);font-weight:700}
.chg-t-rm{color:var(--red);text-decoration:line-through}
.chg-conf{font-size:7px;padding:1px 4px;border-radius:2px;margin-left:4px}
.chg-conf-low{background:rgba(252,211,77,.12);color:#fbbf24}
.chg-conf-error{background:rgba(248,113,113,.12);color:var(--red)}

/* ── Events ── */
.ev-filters{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px}
.ev-flt{font-size:9px;padding:3px 8px;border-radius:10px;cursor:pointer;border:1px solid var(--border);color:var(--muted);transition:all .15s;-webkit-tap-highlight-color:transparent;user-select:none}
.ev-flt.on{border-color:var(--accent-border);color:var(--accent);background:var(--accent-dim)}
.ev-day{font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);padding:10px 0 4px;border-bottom:1px solid var(--border);font-weight:700}
.ev-day:first-child{padding-top:4px}
.ev-item{padding:8px 0;border-bottom:1px solid var(--border)}
.ev-item:last-child{border-bottom:none}
.ev-hdr{display:flex;align-items:center;gap:6px;cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none}
.ev-time{font-size:10px;color:var(--dim);min-width:48px;flex-shrink:0;font-variant-numeric:tabular-nums}
.ev-type{font-size:8px;font-weight:700;padding:2px 6px;border-radius:3px;text-transform:uppercase;letter-spacing:.3px;flex-shrink:0;white-space:nowrap}
.ev-t-reschedule_ok{background:rgba(74,222,128,.15);color:var(--green)}
.ev-t-reschedule_fail{background:rgba(248,113,113,.15);color:var(--red)}
.ev-t-relogin{background:rgba(96,165,250,.12);color:#60a5fa}
.ev-t-session_expired{background:rgba(252,211,77,.12);color:var(--amber)}
.ev-t-soft_ban{background:rgba(252,211,77,.12);color:var(--amber)}
.ev-t-tcp_blocked{background:rgba(248,113,113,.12);color:var(--red)}
.ev-t-error{background:rgba(248,113,113,.10);color:var(--red)}
.ev-t-cas_update{background:rgba(167,139,250,.1);color:var(--accent)}
.ev-t-better_date{background:rgba(103,232,249,.10);color:var(--cyan)}
.ev-sum{font-size:11px;color:var(--text);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ev-arrow{font-size:8px;color:var(--dim);transition:transform .15s;flex-shrink:0}
.ev-item.open .ev-arrow{transform:rotate(90deg)}
.ev-body{display:none;padding:6px 0 2px 54px;font-size:10px;color:var(--muted);line-height:1.7}
.ev-item.open .ev-body{display:block}
/* Reschedule card */
.ev-rsch{background:var(--surface2);border-radius:6px;padding:8px 10px;margin:4px 0}
.ev-rsch-dates{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ev-rsch-old{color:var(--muted);text-decoration:line-through;font-size:11px}
.ev-rsch-arrow{color:var(--dim);font-size:10px}
.ev-rsch-new{color:var(--green);font-weight:700;font-size:12px}
.ev-rsch-new.fail{color:var(--red);text-decoration:none;font-weight:400}
.ev-rsch-cas{font-size:9px;color:var(--dim);margin-top:2px}
/* Attempt table */
.ev-att{width:100%;margin-top:6px;font-size:10px;border-collapse:collapse}
.ev-att th{font-size:8px;padding:4px 6px;text-align:left;color:var(--dim);border-bottom:1px solid var(--border);text-transform:uppercase;letter-spacing:.4px}
.ev-att td{padding:4px 6px;font-size:10px;border-bottom:1px solid var(--border);vertical-align:top}
.ev-att tr:last-child td{border-bottom:none}
.ev-att code{background:rgba(255,255,255,.05);padding:1px 5px;border-radius:2px;font-size:9px;color:var(--text)}
.ev-att .err-msg{color:var(--red);font-size:9px;display:block;margin-top:2px;word-break:break-all}
.ev-att .err-cause{color:var(--amber);font-size:9px;display:block;margin-top:1px;word-break:break-all}
/* Key-value pairs */
.ev-kv{display:inline-block;margin-right:10px}
.ev-k{color:var(--dim)}.ev-v{color:var(--text)}
/* Error block */
.ev-err{background:rgba(248,113,113,.06);border-left:2px solid var(--red);padding:4px 8px;margin:4px 0;border-radius:0 4px 4px 0;font-size:10px;color:var(--red);word-break:break-all}
.ev-err-cause{color:var(--amber);display:block;margin-top:2px;font-size:9px}
/* CAS changes */
.ev-cas-ch{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}

/* ── Top 5 ── */
.top5-row{display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--border)}
.top5-row:last-child{border-bottom:none}
.top5-rank{font-size:9px;color:var(--dim);width:16px}
.top5-date{font-size:12px;font-weight:700;color:var(--bright)}
.top5-ago{font-size:9px;color:var(--muted)}

/* ── Chart toggle ── */
.chart-toggle{display:flex;gap:2px;margin-left:auto}
.ct-btn{font-size:8px;padding:2px 6px;border-radius:3px;cursor:pointer;color:var(--muted);text-transform:none;letter-spacing:0;
  -webkit-tap-highlight-color:transparent;transition:all .15s}
.ct-btn.ct-on{background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent-border)}


.empty{color:var(--muted);text-align:center;padding:14px;font-size:11px}
.sk{background:linear-gradient(90deg,var(--surface) 25%,var(--surface2) 50%,var(--surface) 75%);
  background-size:200%;animation:shimmer 2s infinite;border-radius:3px;height:14px;display:inline-block}
@keyframes shimmer{0%{background-position:200%}100%{background-position:-200%}}
.foot{font-size:9px;color:var(--dim);text-align:center;padding:8px 0 16px;letter-spacing:.5px}

/* ── Calendar ── */
.cal-nav{display:inline-flex;align-items:center;gap:6px;margin-left:auto;font-size:11px}
.cal-nav-btn{cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none;
  color:var(--accent);font-size:16px;font-weight:700;padding:0 4px;line-height:1;transition:opacity .15s}
.cal-nav-btn:active{opacity:.5}
.cal-nav-btn.dis{color:var(--dim);pointer-events:none}
.cal-meta{font-size:10px;color:var(--muted);line-height:1.6;padding:2px 0}
.cal-meta b{color:var(--text);font-weight:700}

.cal-months{display:flex;gap:8px;flex-wrap:wrap}
.cal-month{flex:1;min-width:200px}
.cal-month-title{font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;text-align:center;margin-bottom:4px}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.cal-hdr{font-size:8px;color:var(--dim);text-align:center;padding:2px 0;text-transform:uppercase}
.cal-cell{position:relative;height:28px;display:flex;align-items:center;justify-content:center;
  font-size:10px;border-radius:4px;color:var(--dim);transition:background .15s}
.cal-cell.other{opacity:.2}
.cal-cell.today{box-shadow:inset 0 0 0 1.5px var(--accent)}
.cal-cell.wknd{color:rgba(248,113,113,.35)}
.cal-cell.avail{background:rgba(74,222,128,.15);color:var(--green);font-weight:700}
.cal-cell.avail.wknd{background:rgba(74,222,128,.08);color:rgba(74,222,128,.7)}
.cal-cell.excl{background:repeating-linear-gradient(135deg,transparent,transparent 3px,rgba(248,113,113,.1) 3px,rgba(248,113,113,.1) 5px)}
.cal-cell.excl.avail{background:
  repeating-linear-gradient(135deg,transparent,transparent 3px,rgba(248,113,113,.12) 3px,rgba(248,113,113,.12) 5px),
  rgba(74,222,128,.08);color:rgba(74,222,128,.6);font-weight:700}
.cal-cell.appt::after{content:'';position:absolute;bottom:2px;left:50%;transform:translateX(-50%);
  width:5px;height:5px;border-radius:50%;background:var(--accent)}
.cal-cell.appeared::before{content:'';position:absolute;top:2px;right:2px;
  width:4px;height:4px;border-radius:50%;background:var(--cyan)}
.cal-cell.disappeared{text-decoration:line-through;text-decoration-color:var(--red)}

.cal-legend{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;font-size:8px;color:var(--muted);justify-content:center}
.cal-leg{display:flex;align-items:center;gap:3px}
.cal-sw{display:inline-block;width:10px;height:10px;border-radius:2px}

.cal-changes{font-size:10px;color:var(--muted)}
.cal-mode{display:flex;gap:2px;margin-left:8px}

/* ── Cancelaciones ── */
.tl-sum{display:flex;gap:10px;flex-wrap:wrap;font-size:10px;margin-bottom:4px}
.tl-detail{font-size:10px;padding:6px 8px;margin-top:4px;background:var(--surface2);border-radius:4px;border:1px solid var(--border);display:none}
.tl-detail-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0}
.tl-detail-date{font-weight:700;font-size:11px}
.tl-detail-tag{font-size:8px;padding:1px 5px;border-radius:3px;display:inline-block}
.tl-detail .pairs{margin-top:4px;border-top:1px solid var(--border);padding-top:4px}
.tl-detail .pair{display:flex;gap:8px;align-items:center;padding:1px 0;font-size:9px}
.cal-ch-item{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)}
.cal-ch-item:last-child{border-bottom:none}
.cal-ch-date{font-weight:700;min-width:46px}
.cal-ch-app{color:var(--green)}
.cal-ch-dis{color:var(--red);text-decoration:line-through}
.hlth-chain{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)}
.hlth-chain:last-child{border-bottom:none}
.hlth-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.hlth-lbl{font-size:10px;font-weight:700;color:var(--bright);min-width:38px}
.hlth-stat{font-size:9px;color:var(--muted)}
.hlth-stat b{color:var(--bright);font-weight:700}
.hlth-alert{font-size:9px;padding:4px 8px;border-radius:4px;margin-bottom:3px}
.hlth-alert-warning{background:rgba(252,211,77,.08);color:var(--amber);border:1px solid rgba(252,211,77,.15)}
.hlth-alert-critical{background:rgba(248,113,113,.08);color:var(--red);border:1px solid rgba(248,113,113,.15)}
.hlth-ip-tbl{width:100%;border-collapse:collapse;font-size:9px}
.hlth-ip-tbl th{text-align:left;color:var(--muted);font-weight:400;padding:2px 4px;border-bottom:1px solid var(--border)}
.hlth-ip-tbl td{padding:3px 4px;border-bottom:1px solid var(--border)}
.hlth-ip-tbl tr:last-child td{border-bottom:none}
.hlth-bar{height:3px;border-radius:2px;background:var(--surface2);min-width:30px}
.hlth-bar-fill{height:100%;border-radius:2px}

/* ── Proxy Pool Panel ── */
.pp-header{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.pp-summary{font-size:9px;color:var(--muted);margin-left:auto}
.pp-dots{display:flex;gap:4px;align-items:center}
.pp-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0}
.pp-dot.closed{background:var(--green)}
.pp-dot.half_open{background:var(--amber)}
.pp-dot.open{background:var(--red);opacity:.7}
.pp-label{font-size:8px;font-weight:700;margin-left:2px}
.pp-ip-row{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border);font-size:10px}
.pp-ip-row:last-child{border-bottom:none}
.pp-ip-name{min-width:28px;font-weight:700}
.pp-ip-state{font-size:8px;padding:1px 5px;border-radius:3px;text-transform:uppercase;letter-spacing:.3px;flex-shrink:0}
.pp-state-closed{background:rgba(74,222,128,.1);color:var(--green)}
.pp-state-half_open{background:rgba(252,211,77,.1);color:var(--amber)}
.pp-state-open{background:rgba(248,113,113,.1);color:var(--red)}
.pp-bar-wrap{display:flex;align-items:center;gap:4px;margin-left:auto}
.pp-bar{width:36px;height:3px;border-radius:2px;background:var(--surface2);overflow:hidden}
.pp-bar-fill{height:100%;border-radius:2px}
.pp-stat{font-size:9px;color:var(--muted);min-width:28px;text-align:right}
.pp-cd{font-size:8px;color:var(--red);min-width:40px;text-align:right}
.pp-ev-list{margin-top:6px;padding-top:6px;border-top:1px solid var(--border)}
.pp-ev{display:flex;align-items:baseline;gap:5px;padding:3px 0;font-size:9px;color:var(--muted)}
.pp-ev-icon{flex-shrink:0;font-size:9px;min-width:10px;text-align:center}
.pp-ev-time{color:var(--dim);min-width:38px;flex-shrink:0;font-variant-numeric:tabular-nums}
.pp-ev-body{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── Bookable Events ── */
.be-row{display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;align-items:center;
  padding:5px 0;border-bottom:1px solid var(--border);font-size:10px}
.be-row:last-child{border-bottom:none}
.be-date{font-size:11px;color:var(--bright);font-weight:700;letter-spacing:.3px}
.be-when{color:var(--dim);font-size:9px}
.be-imp{color:var(--cyan);font-size:9px;text-align:right}
.be-badge{font-size:9px;padding:2px 5px;border-radius:3px;font-weight:700;
  letter-spacing:.5px;text-transform:uppercase;background:var(--surface2)}
.be-badge.success{color:var(--green);background:rgba(74,222,128,0.1)}
.be-badge.warn{color:var(--amber);background:rgba(252,211,77,0.1)}
.be-badge.err{color:var(--red);background:rgba(248,113,113,0.1)}
.be-badge.muted{color:var(--muted)}
.be-badge.info{color:var(--cyan);background:rgba(103,232,249,0.1)}

/* Phone edit */
.phone-edit-wrap{display:flex;align-items:center;gap:4px}
.phone-edit-wrap input{background:#0C0C0E;border:1px solid rgba(74,222,128,.25);color:#4ADE80;
  font-family:inherit;font-size:10px;padding:3px 8px;border-radius:4px;width:120px;outline:none}
.phone-edit-wrap input:focus{border-color:rgba(74,222,128,.5);box-shadow:0 0 0 1px rgba(74,222,128,.15)}
.phone-edit-wrap input::placeholder{color:#3A3A42}
.phone-save-btn{cursor:pointer;font-size:9px;font-weight:700;padding:3px 8px;border-radius:4px;
  background:rgba(74,222,128,.12);color:#4ADE80;border:1px solid rgba(74,222,128,.2);
  font-family:inherit;transition:background .15s}
.phone-save-btn:hover{background:rgba(74,222,128,.2)}
.phone-cancel-btn{cursor:pointer;font-size:9px;padding:3px 6px;border-radius:4px;
  color:#5A5A65;border:1px solid rgba(255,255,255,.06);background:transparent;
  font-family:inherit;transition:color .15s}
.phone-cancel-btn:hover{color:#A0A0AB}
.phone-display-val{color:#4ADE80;cursor:pointer;text-align:right;overflow:hidden;text-overflow:ellipsis;
  transition:opacity .15s}
.phone-display-val:hover{opacity:.7}
.phone-add-btn{font-size:9px;color:#5A5A65;cursor:pointer;padding:2px 8px;border-radius:4px;
  border:1px dashed #3A3A42;transition:all .15s}
.phone-add-btn:hover{color:#4ADE80;border-color:rgba(74,222,128,.3)}

/* Cobros */
.cobro-cfg{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center}
.cobro-cfg label{font-size:9px;color:var(--muted);display:flex;align-items:center;gap:4px}
.cobro-cfg input,.cobro-cfg select{background:#0C0C0E;border:1px solid rgba(255,255,255,.06);
  color:#E4E4E9;font-family:inherit;font-size:10px;padding:2px 6px;border-radius:3px;width:60px;outline:none}
.cobro-cfg input:focus,.cobro-cfg select:focus{border-color:rgba(167,139,250,.3)}
.cobro-cfg select{width:56px;cursor:pointer}
.cobro-list{display:flex;flex-direction:column;gap:3px;margin-bottom:4px}
.cobro-item{display:flex;align-items:center;gap:8px;padding:7px 10px;
  background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:10px;cursor:pointer;
  transition:border-color .15s}
.cobro-item:hover{border-color:var(--accent-border)}
.cobro-item.checked{border-color:rgba(74,222,128,.3);background:rgba(74,222,128,.03)}
.cobro-cb{width:14px;height:14px;accent-color:#4ADE80;cursor:pointer;flex-shrink:0}
.cobro-dates{flex:1;min-width:0}
.cobro-old{color:var(--muted);text-decoration:line-through}
.cobro-arrow{color:var(--dim)}
.cobro-new{color:var(--bright);font-weight:700}
.cobro-days{color:var(--green);font-weight:700;min-width:36px;text-align:right;font-size:9px}
.cobro-sub{color:var(--text);min-width:65px;text-align:right;font-size:9px}
.cobro-total-row{display:flex;justify-content:space-between;align-items:baseline;
  padding:10px 12px;border-top:1px solid var(--border);margin-top:4px}
.cobro-total-lbl{font-size:10px;color:var(--muted)}
.cobro-total-val{font-size:16px;font-weight:800;color:var(--green)}
.cobro-detail{font-size:9px;color:var(--dim);margin-top:2px}
.cobro-actions{display:flex;gap:8px;margin-top:12px;align-items:stretch}
.cobro-wa-btn{display:flex;align-items:center;gap:6px;padding:8px 14px;
  background:#25D366;color:#fff;border:none;border-radius:6px;cursor:pointer;
  font-family:inherit;font-size:11px;font-weight:700;flex-shrink:0;transition:opacity .15s}
.cobro-wa-btn:hover{opacity:.85}
.cobro-wa-btn svg{width:18px;height:18px;fill:#fff}
.cobro-preview-wrap{flex:1;position:relative}
.cobro-preview{width:100%;background:#0C0C0E;border:1px solid rgba(255,255,255,.06);border-radius:6px;
  padding:8px 10px;font-family:inherit;font-size:9px;color:#A0A0AB;line-height:1.5;
  resize:none;min-height:100px;box-sizing:border-box;outline:none}
.cobro-copy{position:absolute;top:4px;right:4px;background:#161618;border:1px solid rgba(255,255,255,.06);
  color:#5A5A65;font-size:8px;padding:2px 6px;border-radius:3px;cursor:pointer;font-family:inherit}
.cobro-copy:hover{color:#E4E4E9}
.cobro-no-phone{font-size:10px;color:var(--amber);margin-top:8px}
.cobro-empty{text-align:center;padding:30px 20px;color:var(--muted);font-size:11px}
</style>
</head>
<body>

<!-- Header -->
<div class="hdr">
  <a href="/dashboard" style="text-decoration:none;color:var(--muted);font-size:14px;margin-right:6px" title="todos los bots">‹</a>
  <div class="hdr-title"><span id="botFlag"></span> visa bot <span>#${botId}</span><span class="cursor">_</span></div>
  <div class="hdr-clock" id="clock">--:--:--</div>
</div>

<!-- Countdown -->
<div class="cd-bar"><div class="cd-fill" id="cdFill" style="width:100%"></div></div>
<div class="cd-text"><span id="cdPhase">--</span> &middot; <span id="cdTime">--</span></div>

<!-- Status strip -->
<div class="strip">
  <span id="statusChip" class="chip chip-active">--</span>
  <span class="sep">&middot;</span>
  <span><span class="strip-lbl">ses</span><span id="sesAge" class="strip-val">--</span></span>
  <span class="sep">&middot;</span>
  <span><span class="strip-lbl">err</span><span id="errCount" class="strip-val">0</span></span>
  <span class="sep">&middot;</span>
  <span><span class="strip-lbl">via</span><span id="proxyVal" class="strip-val" style="font-size:10px">--</span></span>
  <span class="sep">&middot;</span>
  <span><span class="strip-lbl">poll</span><span id="pollSrc" class="strip-val" style="font-size:10px">--</span></span>
  <span class="sep">&middot;</span>
  <span><span class="strip-lbl">ritmo</span><span id="batchRate" class="strip-val" style="font-size:10px">--</span></span>
  <span id="lastRsRow" style="display:none"><span class="sep">&middot;</span><span class="strip-lbl">resch</span><span id="lastRsVal" class="strip-val" style="font-size:10px">--</span></span>
  <span id="ownerEmailRow" style="display:none"><span class="sep">&middot;</span><span class="strip-lbl">owner</span><span id="ownerEmailVal" class="strip-val" style="font-size:9px;color:var(--accent)">--</span></span>
  <span id="phoneRow" style="display:none"><span class="sep">&middot;</span><span class="strip-lbl">wa</span><span id="phoneVal" class="strip-val" style="font-size:9px;color:var(--green)">--</span></span>
  <div id="actions" class="actions" style="display:none;width:100%;margin-top:4px"></div>
  <div id="emergDiv" style="display:none;width:100%;margin-top:2px">
    <div class="emerg-lbl">emergencia</div>
    <div class="actions">
      <button class="btn btn-w" onclick="emergAct(\'force-login\')">forzar login</button>
      <button class="btn btn-w" onclick="emergAct(\'restart-chain\')">restart cadena</button>
    </div>
  </div>
</div>

<!-- Appointment -->
<div class="card">
  <div class="card-t">cita actual</div>
  <div class="appt">
    <div class="appt-row">
      <span class="appt-lbl">consular</span>
      <span><span id="conDate" class="appt-val"><span class="sk" style="width:100px">&nbsp;</span></span><span id="conDays" class="appt-days"></span></span>
    </div>
    <div id="casRow" class="appt-row appt-cas">
      <span class="appt-lbl">cas</span>
      <span><span id="casDate" class="appt-val"><span class="sk" style="width:100px">&nbsp;</span></span><span id="casDays" class="appt-days"></span></span>
    </div>
    <div id="skipCasLbl" style="display:none;margin-top:2px;font-size:9px;color:var(--muted);letter-spacing:.5px">solo consular (renovaci\u00f3n)</div>
    <div id="targetRow" class="appt-row" style="display:none;margin-top:4px;border-top:1px solid var(--border);padding-top:6px">
      <span class="appt-lbl" style="color:var(--muted)">objetivo</span>
      <span><span id="targetVal" class="appt-val" style="font-size:12px"></span><span id="targetWindow" class="appt-days"></span></span>
    </div>
    <div id="rsLimitRow" class="appt-row" style="display:none">
      <span id="rsLimitLbl" class="appt-lbl" style="color:var(--muted)">intentos</span>
      <span id="rsLimitVal" style="font-size:11px;font-weight:700"></span>
    </div>
    <div id="exclRow" style="display:none;margin-top:5px;padding-top:5px;border-top:1px solid var(--border);font-size:9px;line-height:1.8"></div>
  </div>
</div>

<!-- Bot info -->
<div id="botInfoCard" class="card" style="display:none">
  <div class="card-t">info cuenta</div>
  <div style="display:flex;flex-direction:column;gap:4px;font-size:10px">
    <div style="display:flex;justify-content:space-between;gap:12px"><span style="color:var(--muted);flex-shrink:0">visa email</span><span id="infoEmail" style="color:var(--bright);font-weight:700;text-align:right;overflow:hidden;text-overflow:ellipsis">--</span></div>
    <div id="infoClerkRow" style="display:none;justify-content:space-between;gap:12px"><span style="color:var(--muted);flex-shrink:0">registro</span><span id="infoClerkEmail" style="color:var(--cyan);text-align:right;overflow:hidden;text-overflow:ellipsis">--</span></div>
    <div style="display:flex;justify-content:space-between;gap:12px"><span style="color:var(--muted);flex-shrink:0">schedule</span><span id="infoSchedule" style="color:var(--accent);font-weight:700">--</span></div>
    <div style="display:flex;justify-content:space-between;gap:12px"><span style="color:var(--muted);flex-shrink:0">applicants</span><span id="infoApplicants" style="color:var(--bright);text-align:right;overflow:hidden;text-overflow:ellipsis">--</span></div>
    <div id="infoOwnerRow" style="display:flex;justify-content:space-between;gap:12px"><span style="color:var(--muted);flex-shrink:0">owner</span><span id="infoOwner" style="color:var(--text);text-align:right;overflow:hidden;text-overflow:ellipsis">--</span></div>
    <div id="infoNotifRow" style="display:flex;justify-content:space-between;gap:12px"><span style="color:var(--muted);flex-shrink:0">notif</span><span id="infoNotif" style="color:var(--text);text-align:right;overflow:hidden;text-overflow:ellipsis">--</span></div>
    <div id="infoPhoneRow" style="display:flex;justify-content:space-between;gap:12px;align-items:center">
      <span style="color:var(--muted);flex-shrink:0">whatsapp</span>
      <span id="infoPhoneDisplay">
        <span id="infoPhone" class="phone-display-val" onclick="editPhone()">--</span>
      </span>
      <span id="infoPhoneAdd" style="display:none">
        <span class="phone-add-btn" onclick="editPhone()">+ agregar</span>
      </span>
      <span id="infoPhoneEdit" style="display:none" class="phone-edit-wrap">
        <input id="phoneInput" placeholder="573..." />
        <button onclick="savePhone()" class="phone-save-btn">ok</button>
        <button onclick="cancelPhoneEdit()" class="phone-cancel-btn">\u2715</button>
      </span>
    </div>
    <div style="border-top:1px solid var(--border);margin:4px 0"></div>
    <div id="infoActivatedRow" style="display:none;justify-content:space-between;gap:12px"><span style="color:var(--muted);flex-shrink:0">activado</span><span id="infoActivated" style="color:var(--bright)">--</span></div>
    <div id="infoOrigDateRow" style="display:none;justify-content:space-between;gap:12px"><span style="color:var(--muted);flex-shrink:0">cita original</span><span id="infoOrigDate" style="color:var(--amber)">--</span></div>
  </div>
</div>

<div class="tabs">
  <div class="tab on" onclick="switchTab(0)">monitor</div>
  <div id="casTabBtn" class="tab" onclick="switchTab(1)">cas map</div>
  <div class="tab" onclick="switchTab(2)">eventos</div>
  <div class="tab" onclick="switchTab(3)">calendario</div>
  <div class="tab" onclick="switchTab(4)">cobros</div>
</div>


<!-- ═══ MONITOR TAB ═══ -->
<div id="t0" class="tab-c on">

<div class="card">
  <div class="card-t">tendencia
    <span class="chart-toggle">
      <span class="ct-btn ct-on" onclick="setChartMode(0)" id="ctRecent">reciente</span>
      <span class="ct-btn" onclick="setChartMode(1)" id="ct24h">24h</span>
    </span>
  </div>
  <div class="chart-wrap">
    <canvas id="trendCanvas"></canvas>
    <div id="chartEmpty" class="chart-empty" style="display:none">sin datos suficientes</div>
  </div>
</div>

<div class="card">
  <div class="card-t">ultimo poll</div>
  <div class="poll-latest">
    <div class="pl-item"><span class="pl-lbl">hora</span><span id="lpTime" class="pl-val">--</span></div>
    <div class="pl-item"><span class="pl-lbl">status</span><span id="lpStatus" class="pl-val">--</span></div>
    <div class="pl-item"><span class="pl-lbl">fechas</span><span id="lpDates" class="pl-val">--</span></div>
    <div class="pl-item"><span class="pl-lbl">mejor</span><span id="lpBest" class="pl-val">--</span></div>
    <div class="pl-item"><span class="pl-lbl">latencia</span><span id="lpMs" class="pl-val">--</span></div>
    <div class="pl-item"><span class="pl-lbl">nodo</span><span id="lpNode" class="pl-val">--</span></div>
    <div class="pl-item"><span class="pl-lbl">resch</span><span id="lpRs" class="pl-val">--</span></div>
    <div id="lpConnRow" class="pl-item" style="display:none"><span class="pl-lbl">proxy</span><span id="lpConn" class="pl-val" style="font-size:10px;font-weight:400">--</span></div>
    <div id="lpMotivoRow" class="pl-item" style="display:none;grid-column:1/-1;border-top:1px solid var(--border);padding-top:4px;margin-top:2px"><span class="pl-lbl">motivo</span><span id="lpMotivo" class="pl-val" style="font-size:10px;color:var(--amber);font-weight:400;white-space:normal;word-break:break-all"></span></div>
  </div>
</div>

<div class="card" id="healthCard">
  <div class="card-t"><span class="coll-hdr" onclick="toggle(this)">health</span><span id="healthRate" style="font-size:9px;color:var(--dim)"></span></div>
  <div class="coll-body">
    <div id="healthChains" style="margin-bottom:6px"></div>
    <div id="healthAlerts"></div>
    <div id="healthIps" style="margin-top:6px"></div>
    <div id="healthEmpty" class="empty">cargando...</div>
  </div>
</div>

<div class="card collapsed" id="proxyPoolCard" style="display:none">
  <div class="card-t"><span class="coll-hdr" onclick="toggle(this)">proxy pool</span><span id="ppSummary" style="font-size:9px;color:var(--dim)"></span></div>
  <div class="coll-body">
    <div id="ppIps"></div>
    <div id="ppEvents" class="pp-ev-list" style="display:none"></div>
    <div id="ppEmpty" class="empty" style="display:none">sin datos</div>
  </div>
</div>

<div class="card">
  <div class="card-t">mejores en 24h</div>
  <div id="top5List" class="top5"></div>
  <div id="top5Empty" class="empty">cargando...</div>
</div>

<div class="card">
  <div class="card-t">cancelaciones</div>
  <div class="tl-sum" id="tlSum"></div>
  <div class="chart-wrap" style="height:150px">
    <canvas id="tlCanvas"></canvas>
    <div id="tlEmpty" class="chart-empty" style="display:none">sin cancelaciones</div>
  </div>
  <div class="tl-sum" id="tlLeg" style="justify-content:center;margin-top:4px;font-size:8px;color:var(--muted)"></div>
  <div class="tl-detail" id="tlDetail"></div>
</div>

<div class="card">
  <div class="card-t"><span class="coll-hdr" onclick="toggle(this)">historial</span><span id="pollCount" style="font-size:9px;color:var(--dim)">0</span></div>
  <div class="coll-body">
    <table>
      <thead><tr><th>hora</th><th>nodo</th><th>st</th><th>#</th><th>mejor</th><th>ms</th></tr></thead>
      <tbody id="pollTb"></tbody>
    </table>
    <div id="pollEmpty" class="empty" style="display:none">sin polls</div>
  </div>
</div>

<div class="card" id="beCard">
  <div class="card-t">candidatas agendables
    <span id="beSummary" style="font-weight:400;color:var(--dim)"></span>
  </div>
  <div style="display:flex;gap:4px;margin-bottom:8px" id="beFilters">
    <button class="tab be-f on" data-f="all" onclick="setBeFilter(\'all\')">todos</button>
    <button class="tab be-f" data-f="failed" onclick="setBeFilter(\'failed\')">fallidas</button>
    <button class="tab be-f" data-f="success" onclick="setBeFilter(\'success\')">éxitos</button>
  </div>
  <div id="beList"></div>
  <div id="beEmpty" class="empty" style="display:none">sin candidatas en ventana</div>
</div>

<div class="card collapsed">
  <div class="card-t"><span class="coll-hdr" onclick="toggle(this)">reagendamientos</span></div>
  <div class="coll-body">
    <div id="rsList"></div>
    <div id="rsEmpty" class="empty" style="display:none">sin reschedules</div>
  </div>
</div>

</div>

<!-- ═══ CAS TAB ═══ -->
<div id="t1" class="tab-c">

<div class="card">
  <div class="card-t">disponibilidad cas &middot; 30 dias</div>
  <div class="hm-summary">
    <span><span class="strip-lbl">cache</span><span id="hmAge" class="strip-val">--</span></span>
    <span><span class="strip-lbl">disponibles</span><span id="hmAvail" class="strip-val" style="color:var(--green)">--</span></span>
    <span><span class="strip-lbl">full</span><span id="hmFull" class="strip-val" style="color:var(--red)">--</span></span>
  </div>
  <div id="heatmap" class="hm"></div>
</div>

<div class="card">
  <div class="card-t"><span class="coll-hdr" onclick="toggle(this)">cambios de slots</span></div>
  <div class="coll-body">
    <div id="casChanges"></div>
    <div id="casChgEmpty" class="empty" style="display:none">sin cambios recientes</div>
  </div>
</div>

</div>

<!-- ═══ EVENTS TAB ═══ -->
<div id="t2" class="tab-c">
<div class="card">
  <div class="card-t">eventos</div>
  <div class="ev-filters" id="evFilters">
    <span class="ev-flt on" data-f="all">todos</span>
    <span class="ev-flt on" data-f="reschedule">reschedule</span>
    <span class="ev-flt on" data-f="error">errores</span>
    <span class="ev-flt on" data-f="session">sesion</span>
    <span class="ev-flt on" data-f="cas">cas</span>
  </div>
  <div id="evList"></div>
  <div id="evEmpty" class="empty">cargando...</div>
</div>
</div>

<!-- ═══ CALENDAR TAB ═══ -->
<div id="t3" class="tab-c">

<div class="card">
  <div class="card-t">poll seleccionado
    <span class="cal-mode">
      <span class="ct-btn ct-on" onclick="setCalMode(0)" id="calModeBest">mejores</span>
      <span class="ct-btn" onclick="setCalMode(1)" id="calModeAll">todos</span>
      <span class="ct-btn" onclick="setCalMode(2)" id="calModeFlash">flash</span>
      <span class="ct-btn" onclick="setCalMode(3)" id="calModeHistory">historia</span>
    </span>
    <span class="cal-nav">
      <span class="cal-nav-btn" id="calPollPrev" onclick="calNavPoll(-1)">&lsaquo;</span>
      <span id="calPollInfo" style="font-size:10px;color:var(--text);min-width:40px;text-align:center">--</span>
      <span class="cal-nav-btn" id="calPollNext" onclick="calNavPoll(1)">&rsaquo;</span>
    </span>
  </div>
  <div id="calPollMeta" class="cal-meta">cargando...</div>
</div>

<div class="card">
  <div class="card-t">disponibilidad consular
    <span class="cal-nav">
      <span class="cal-nav-btn" id="calMonPrev" onclick="calNavMonth(-1)">&lsaquo;</span>
      <span id="calMonInfo" style="font-size:10px;color:var(--text);min-width:80px;text-align:center">--</span>
      <span class="cal-nav-btn" id="calMonNext" onclick="calNavMonth(1)">&rsaquo;</span>
    </span>
  </div>
  <div id="calGrid"></div>
  <div id="calLegend" class="cal-legend"></div>
</div>

<div class="card">
  <div class="card-t">cambios vs poll anterior</div>
  <div id="calChanges" class="cal-changes"></div>
</div>

</div>

<!-- ═══ COBROS TAB ═══ -->
<div id="t4" class="tab-c">
  <div id="cobrosContent" class="cobro-empty">selecciona el tab para cargar</div>
</div>

<div class="foot">tap header to refresh &middot; auto 60s</div>

<div id="toast" class="toast"></div>

<script>
var BID=${botId},API='/api',TZ={timeZone:'America/Bogota'};
var DSE=['dom','lun','mar','mie','jue','vie','sab'];
var CMETA=${JSON.stringify(COUNTRY_META)};
var WEBSHARE_IPS=${JSON.stringify(webshareIps)};
var WEBSHARE_COLORS=['#F0ABFC','#C4B5FD','#93C5FD','#86EFAC','#FDE68A','#FDA4AF','#A5B4FC','#6EE7B7','#FCA5A5','#D8B4FE'];
var IS_WEBSHARE_BOT=false;
function fmtNode(p){
  var ci=p.chainId,ip=p.publicIp;
  var cPfx=ci==='cloud'
    ?'<span style="color:var(--cyan);font-size:7px;font-weight:700">cld</span><span style="color:var(--dim);font-size:7px">:</span>'
    :'<span style="color:var(--amber);font-size:7px;font-weight:700">dev</span><span style="color:var(--dim);font-size:7px">:</span>';
  if(ci==='cloud')
    return cPfx+'<span style="color:#22D3EE;font-size:8px;font-weight:700" title="Cloud Direct ('+(ip||'?')+')">CLD</span>';
  var wIdx=WEBSHARE_IPS.indexOf(ip);
  if(wIdx>=0){
    var wc=WEBSHARE_COLORS[wIdx]||'#94A3B8';
    return cPfx+'<span style="color:'+wc+';font-size:8px;font-weight:700" title="Webshare #'+(wIdx+1)+' ('+(ip||'?')+')">W'+(wIdx+1)+'</span>';
  }
  if(ip)
    return IS_WEBSHARE_BOT
      ?cPfx+'<span style="color:#94A3B8;font-size:8px;font-weight:700" title="Webshare dynamic ('+(ip||'?')+')">Wsh</span>'
      :cPfx+'<span style="color:#FBBF24;font-size:8px;font-weight:700" title="RPi Direct ('+ip+')">RPi</span>';
  return cPfx+'<span style="color:var(--dim);font-size:8px">?</span>';
}
var cd=60,timer,lastBot=null,lastPolls=null,lastSummary=null,chartMode=0;
var calIdx=0,calMonthOffset=0,lastExclusions=null,calPollList=null,calMode=0;
var tlData=null,tlSelDate=null,tlDots=[],tlClickBound=false;
var calPolls=null,dateHistory=null;
var slowCd=0,lastRss=null,lastCasLogs=null,lastBeRows=null; /* slow refresh: reschedules/cas/summary/cancellations/be every 5×60s=5min */
var beData=[],beFilter='all';
var BE_OUTCOME_CLASS={
  success:'success',
  stale_data:'info',
  blocked_limit:'muted',max_reschedules_reached:'muted',
  no_times:'warn',no_cas_days:'warn',no_cas_times:'warn',no_cas_times_cached:'warn',
  post_failed:'err',post_error:'err',session_expired:'err',
  all_candidates_failed:'err',fetch_error:'err',verification_failed:'err'
};

function fmtAgo(iso){
  if(!iso)return'--';
  var ms=Date.now()-new Date(iso).getTime();
  var s=Math.floor(ms/1000);
  if(s<60)return'hace '+s+'s';
  var m=Math.floor(s/60);
  if(m<60)return'hace '+m+'m';
  var h=Math.floor(m/60);
  if(h<24)return'hace '+h+'h';
  return'hace '+Math.floor(h/24)+'d';
}

function setBeFilter(f){
  beFilter=f;
  document.querySelectorAll('.be-f').forEach(function(b){
    b.classList.toggle('on',b.dataset.f===f);
  });
  renderBookableEvents(beData);
}

function renderBookableEvents(rows){
  beData=rows||[];
  var filtered=beFilter==='success'?beData.filter(function(r){return r.outcome==='success';})
    :beFilter==='failed'?beData.filter(function(r){return r.outcome!=='success';})
    :beData;
  var listEl=document.getElementById('beList');
  var emptyEl=document.getElementById('beEmpty');
  var sumEl=document.getElementById('beSummary');
  if(!listEl)return;

  var successCount=beData.filter(function(r){return r.outcome==='success';}).length;
  var failCount=beData.filter(function(r){return r.outcome!=='success';}).length;
  sumEl.textContent=beData.length
    ?successCount+'\u2713 '+failCount+'\u2717 \u00b7 7d'
    :'';

  if(!filtered.length){
    listEl.innerHTML='';emptyEl.style.display='';
    return;
  }
  emptyEl.style.display='none';

  var html='';
  var shown=filtered.slice(0,60);
  for(var i=0;i<shown.length;i++){
    var r=shown[i];
    var cls=BE_OUTCOME_CLASS[r.outcome]||'muted';
    var imp=r.daysImprovement!=null?'<span class="be-imp">+'+r.daysImprovement+'d</span>':'<span></span>';
    var when=fmtAgo(r.detectedAt);
    html+='<div class="be-row">'
      +'<div><div class="be-date">'+fmtD(r.date)+'</div>'
      +'<div class="be-when">'+when+'</div></div>'
      +imp
      +'<span class="be-badge '+cls+'">'+r.outcome.replace(/_/g,' ')+'</span>'
      +'</div>';
  }
  listEl.innerHTML=html;
}

function switchTab(n){
  var tabs=document.querySelectorAll('.tabs>.tab');
  var panes=document.querySelectorAll('.tab-c');
  for(var i=0;i<tabs.length;i++){
    tabs[i].classList.toggle('on',i===n);
    panes[i].classList.toggle('on',i===n);
  }
  if(n===0&&lastPolls&&lastBot)drawChart(lastPolls,lastBot.currentConsularDate,lastSummary,chartMode);
  if(n===3){
    /* Auto-load full detail for current calendar poll */
    var list=getCalPolls();
    if(list.length>0&&!list[calIdx]._full){
      loadPollDetail(list[calIdx]).then(function(){renderCalendar()});
    }
    renderCalendar();
  }
  if(n===4) renderCobros();
}
function toggle(el){el.closest('.card').classList.toggle('collapsed')}

/* ── Formatters ── */
function fmt(iso){
  if(!iso)return'--';
  return new Date(iso).toLocaleString('es-CO',Object.assign({},TZ,{hour:'2-digit',minute:'2-digit',hour12:false}));
}
function fmtTime(iso){
  if(!iso)return'--';
  return new Date(iso).toLocaleString('en-US',Object.assign({},TZ,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}));
}
function fmtD(s){
  if(!s)return'--';
  var p=s.split('-').map(Number);
  var m=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return p[2]+' '+m[p[1]-1]+' '+p[0];
}
function fmtDs(s){
  if(!s)return'--';
  var p=s.split('-').map(Number);
  var now=new Date();var bog=new Date(now.toLocaleString('en-US',TZ));
  var curY=bog.getFullYear();
  return p[2]+'/'+p[1]+(p[0]!==curY?'/'+String(p[0]).slice(2):'');
}
function dow(s){
  var p=s.split('-').map(Number);
  return DSE[new Date(p[0],p[1]-1,p[2]).getDay()];
}
function daysUntil(s){
  if(!s)return'';
  var p=s.split('-').map(Number);
  var t=new Date(p[0],p[1]-1,p[2]);
  var now=new Date();
  var today=new Date(now.toLocaleString('en-US',TZ));
  today.setHours(0,0,0,0);
  var d=Math.ceil((t-today)/864e5);
  if(d===0)return'hoy';if(d===1)return'manana';
  if(d<0)return Math.abs(d)+'d atras';
  return d+'d';
}
function daysUntilNum(s){
  if(!s)return 99999;
  var p=s.split('-').map(Number);
  var t=new Date(p[0],p[1]-1,p[2]);
  var now=new Date();var today=new Date(now.toLocaleString('en-US',TZ));
  today.setHours(0,0,0,0);
  return Math.round((t-today)/864e5);
}
function badge(t,c){return'<span class="b b-'+(c||t)+'">'+t+'</span>'}
function sesStr(c){
  if(!c)return'--';
  var m=Math.floor((Date.now()-new Date(c).getTime())/6e4);
  if(m<1)return'<1m';if(m<60)return m+'m';
  return Math.floor(m/60)+'h'+m%60+'m';
}
function sesColor(c){
  if(!c)return'var(--dim)';
  var m=(Date.now()-new Date(c).getTime())/6e4;
  if(m>80)return'var(--red)';if(m>44)return'var(--amber)';
  return'var(--green)';
}

/* ── Clock ── */
function tickClock(){
  document.getElementById('clock').textContent=new Date().toLocaleString('en-US',
    Object.assign({},TZ,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}));
}

/* ── Countdown ── */
function tickCd(){
  cd--;
  document.getElementById('cdFill').style.width=Math.max(0,cd/60*100)+'%';
  document.getElementById('cdTime').textContent=cd+'s';
  if(cd<=0)refresh();
}

async function fetchJ(u){var r=await fetch(u);if(!r.ok)throw new Error(r.status+'');return r.json()}

/* ── Main refresh ── */
async function refresh(){
  cd=60;document.getElementById('cdFill').style.width='100%';
  try{
    var bot=await fetchJ(API+'/bots/'+BID);
    lastBot=bot;

    /* Fast: live data every 60s */
    var fastRes=await Promise.all([
      fetchJ(API+'/bots/'+BID+'/logs/polls?limit=100'),
      fetchJ(API+'/bots/'+BID+'/logs/polls?hasDate=true&limit=500'),
    ]);
    var polls=fastRes[0];lastPolls=polls;calPolls=fastRes[1];
    var health=computeHealth(polls,15);

    /* Slow: historical data every 5min (5×60s). slowCd=0 on first load to fetch all immediately. */
    var rss=lastRss,casLogs=lastCasLogs,summary=lastSummary,cancelServer=tlData,beRows=lastBeRows;
    if(slowCd<=0){
      slowCd=5;
      var slowRes=await Promise.all([
        fetchJ(API+'/bots/'+BID+'/logs/reschedules?limit=20'),
        fetchJ(API+'/bots/'+BID+'/logs/cas-prefetch?limit=15'),
        fetchJ(API+'/bots/'+BID+'/logs/polls/summary?hours=24'),
        fetchJ(API+'/bots/'+BID+'/logs/date-sightings?hours=24'),
        fetchJ(API+'/bots/'+BID+'/logs/bookable-events?hours=168'),
        fetchJ(API+'/bots/'+BID+'/logs/date-history'),
      ]);
      rss=slowRes[0];casLogs=slowRes[1];summary=slowRes[2];cancelServer=slowRes[3];beRows=slowRes[4];
      var dhRes=slowRes[5];
      lastRss=rss;lastCasLogs=casLogs;lastSummary=summary;tlData=cancelServer;lastBeRows=beRows;
      if(dhRes&&dhRes.days)dateHistory=dhRes.days;
    }
    slowCd--;

    /* Country flag */
    var cc=bot.locale?bot.locale.split('-')[1]:'';
    var cm=CMETA[cc];
    document.getElementById('botFlag').textContent=cm?cm.flag:'';
    document.title=(cm?cm.flag+' ':'')+'Bot #'+BID+' — '+(cm?cm.name:'');

    /* Status */
    var sc=document.getElementById('statusChip');
    sc.textContent=bot.status;sc.className='chip chip-'+bot.status;
    renderActions(bot.status);
    var sa=document.getElementById('sesAge');
    sa.textContent=sesStr(bot.sessionCreatedAt);sa.style.color=sesColor(bot.sessionCreatedAt);
    var ec=document.getElementById('errCount');
    ec.textContent=bot.consecutiveErrors||'0';
    ec.style.color=bot.consecutiveErrors>0?'var(--red)':'var(--green)';
    document.getElementById('proxyVal').textContent=bot.proxyProvider||'direct';
    IS_WEBSHARE_BOT=bot.proxyProvider==='webshare';
    /* Poll source */
    var envs=bot.pollEnvironments||['dev'];
    var srcParts=[];
    if(envs.indexOf('dev')>=0)srcParts.push(bot.activeRunId?'<span style="color:var(--green)">dev</span>':'<span style="color:var(--dim)">dev</span>');
    if(envs.indexOf('prod')>=0)srcParts.push(bot.activeCloudRunId?'<span style="color:var(--green)">cloud</span>':'<span style="color:var(--dim)">cloud</span>');
    document.getElementById('pollSrc').innerHTML=srcParts.join('+');

    /* Polls/min + batch mode indicator */
    var batchRateEl=document.getElementById('batchRate');
    var cutoff5m=Date.now()-5*60*1000;
    var recent5=polls.filter(function(p){return new Date(p.createdAt).getTime()>cutoff5m;});
    var ppm=recent5.length/5;
    var curRunId=polls.length>0?polls[0].runId:null;
    var batchPolls=curRunId?polls.filter(function(p){return p.runId===curRunId;}):[];
    var batchSize=batchPolls.length;
    var maxFetchIdx=batchPolls.reduce(function(m,p){return Math.max(m,p.fetchIndex!=null?p.fetchIndex:0);},0);
    var pollsInBatch=Math.max(batchSize,maxFetchIdx+1);
    var ppmColor=ppm>=8?'var(--green)':ppm>=5?'var(--amber)':'var(--red)';
    var rateHtml='<span style="color:'+ppmColor+';font-weight:700">'+ppm.toFixed(1)+'</span><span style="color:var(--dim);font-size:8px">p/m</span>';
    if(pollsInBatch>1){
      rateHtml+=' <span style="color:var(--accent);font-size:8px;font-weight:600;background:rgba(99,102,241,.12);padding:1px 4px;border-radius:3px">batch:'+pollsInBatch+'</span>';
    }
    batchRateEl.innerHTML=rateHtml;

    /* Owner email (strip) */
    var ownerRow=document.getElementById('ownerEmailRow');
    if(bot.ownerEmail){ownerRow.style.display='';var em2=bot.ownerEmail.split('@');var short2=em2[0].length>12?em2[0].substring(0,12)+'\u2026':em2[0];document.getElementById('ownerEmailVal').textContent=short2+'@\u2026';}else{ownerRow.style.display='none';}
    var phoneRow=document.getElementById('phoneRow');
    if(bot.notificationPhone){phoneRow.style.display='';document.getElementById('phoneVal').textContent=bot.notificationPhone.slice(-4);}else{phoneRow.style.display='none';}

    /* Bot info card */
    var infoCard=document.getElementById('botInfoCard');
    if(bot.visaEmail||bot.applicantIds){
      infoCard.style.display='';
      document.getElementById('infoEmail').textContent=bot.visaEmail||'--';
      var clerkRow=document.getElementById('infoClerkRow');
      if(bot.clerkEmail){clerkRow.style.display='flex';document.getElementById('infoClerkEmail').textContent=bot.clerkEmail;}else{clerkRow.style.display='none';}
      document.getElementById('infoSchedule').textContent=bot.scheduleId||'--';
      document.getElementById('infoApplicants').textContent=bot.applicantIds?bot.applicantIds.join(', '):'--';
      var infoOwnerRow=document.getElementById('infoOwnerRow');
      if(bot.ownerEmail){infoOwnerRow.style.display='flex';document.getElementById('infoOwner').textContent=bot.ownerEmail;}else{infoOwnerRow.style.display='none';}
      var infoNotifRow=document.getElementById('infoNotifRow');
      if(bot.notificationEmail){infoNotifRow.style.display='flex';document.getElementById('infoNotif').textContent=bot.notificationEmail;}else{infoNotifRow.style.display='none';}
      var infoPhoneRow=document.getElementById('infoPhoneRow');
      infoPhoneRow.style.display='flex';
      document.getElementById('infoPhoneEdit').style.display='none';
      if(bot.notificationPhone){
        document.getElementById('infoPhoneDisplay').style.display='';
        document.getElementById('infoPhoneAdd').style.display='none';
        document.getElementById('infoPhone').textContent='+'+bot.notificationPhone;
      }else{
        document.getElementById('infoPhoneDisplay').style.display='none';
        document.getElementById('infoPhoneAdd').style.display='';
      }
      var infoActRow=document.getElementById('infoActivatedRow');
      if(bot.activatedAt){infoActRow.style.display='flex';var ad=new Date(bot.activatedAt);document.getElementById('infoActivated').textContent=fmtDs(ad.toISOString().slice(0,10))+' '+ad.toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',hour12:false});}else{infoActRow.style.display='none';}
      var infoOrigRow=document.getElementById('infoOrigDateRow');
      var origDate=rss.length>0?rss[rss.length-1].oldConsularDate:null;
      if(origDate){infoOrigRow.style.display='flex';document.getElementById('infoOrigDate').textContent=fmtDs(origDate);}else{infoOrigRow.style.display='none';}
    }else{infoCard.style.display='none';}

    /* Last successful reschedule (strip) */
    var lastRsRow=document.getElementById('lastRsRow');
    var lastOk=rss.find(function(r){return r.success;});
    if(lastOk){
      lastRsRow.style.display='';
      var rsMins=Math.round((Date.now()-new Date(lastOk.createdAt).getTime())/6e4);
      var rsAgo=rsMins<60?rsMins+'m':rsMins<1440?Math.floor(rsMins/60)+'h':Math.floor(rsMins/1440)+'d';
      document.getElementById('lastRsVal').innerHTML='<span style="color:var(--green)">hace '+rsAgo+'</span> <span style="color:var(--dim)">→</span> '+fmtDs(lastOk.newConsularDate);
    }else{lastRsRow.style.display='none';}

    /* Appointment */
    var cd2=bot.currentConsularDate;
    document.getElementById('conDate').innerHTML=fmtD(cd2)+(bot.currentConsularTime?' '+bot.currentConsularTime:'');
    document.getElementById('conDays').textContent=daysUntil(cd2);
    /* Hide CAS for countries that don't require ASC appointment */
    var hasCas=bot.ascFacilityId&&bot.ascFacilityId!==''&&!bot.skipCas;
    document.getElementById('casRow').style.display=hasCas?'':'none';
    document.getElementById('casTabBtn').style.display=hasCas?'':'none';
    var skipCasLbl=document.getElementById('skipCasLbl');
    if(skipCasLbl)skipCasLbl.style.display=bot.skipCas?'':'none';
    if(hasCas){
      document.getElementById('casDate').innerHTML=fmtD(bot.currentCasDate)+(bot.currentCasTime?' '+bot.currentCasTime:'');
      document.getElementById('casDays').textContent=daysUntil(bot.currentCasDate);
    }

    /* Target date & improvement window (P0) */
    var targetRow=document.getElementById('targetRow');
    var targetVal=document.getElementById('targetVal');
    var targetWindow=document.getElementById('targetWindow');
    if(bot.targetDateBefore){
      targetRow.style.display='';
      var wDays=daysUntilNum(bot.targetDateBefore);
      var wColor=wDays<=0?'var(--red)':wDays<=14?'var(--amber)':'var(--muted)';
      var wText=wDays<=0?'ventana cerrada':wDays+'d de ventana';
      targetVal.innerHTML='<span style="color:var(--dim);font-size:10px">< </span>'+fmtD(bot.targetDateBefore);
      targetVal.style.color=wDays<=0?'var(--red)':'var(--text)';
      targetWindow.innerHTML='<span style="color:'+wColor+'">'+wText+'</span>';
    }else{targetRow.style.display='none';}

    /* Reschedule limits (P0) */
    var rsLimitRow=document.getElementById('rsLimitRow');
    var rsLimitVal=document.getElementById('rsLimitVal');
    var rsLimitLbl=document.getElementById('rsLimitLbl');
    if(bot.maxReschedules!=null){
      rsLimitRow.style.display='';
      var used=bot.rescheduleCount||0;var mx=bot.maxReschedules;var rem=mx-used;
      var pctU=Math.min(100,Math.round(used/mx*100));
      var rc=rem<=0?'var(--red)':rem===1?'var(--amber)':'var(--green)';
      var bar='<span class="limits"><span class="bar" style="max-width:48px"><span class="fill" style="width:'+pctU+'%;background:'+rc+'"></span></span></span>';
      if(rem<=0){
        rsLimitLbl.style.color='var(--red)';
        rsLimitVal.innerHTML='<span style="color:var(--red);font-size:11px;font-weight:800;letter-spacing:.3px;text-transform:uppercase">&#9888; no puede reagendar</span>'
          +' <span style="color:var(--dim);font-size:9px">('+used+'/'+mx+')</span> '+bar;
      }else{
        rsLimitVal.innerHTML='<span style="color:'+rc+';font-size:13px;font-weight:800">'+rem+'</span>'
          +'<span style="color:var(--muted);font-size:10px"> restante'+(rem!==1?'s':'')+'</span>'
          +' <span style="color:var(--dim);font-size:9px">('+used+'/'+mx+')</span> '+bar;
      }
    }else{rsLimitRow.style.display='none';}

    /* Active exclusions (P1) */
    var exclRow=document.getElementById('exclRow');
    var excls=bot.excludedDateRanges||[];
    if(excls.length>0){
      var today3=new Date().toLocaleDateString('sv-SE',TZ);
      var actEx=excls.filter(function(e){return e.endDate>=today3;});
      if(actEx.length>0){
        exclRow.style.display='';
        var eh='<span style="color:var(--dim);font-size:8px;text-transform:uppercase;letter-spacing:.5px">excluidos: </span>';
        for(var ei=0;ei<Math.min(actEx.length,4);ei++){
          var ex=actEx[ei];
          var isNow=ex.startDate<=today3&&ex.endDate>=today3;
          eh+='<span style="background:rgba(248,113,113,'+(isNow?'.12':'.06')+');color:'+(isNow?'var(--red)':'var(--muted)')+';padding:1px 6px;border-radius:3px;font-size:8px;margin-right:3px;white-space:nowrap">'+(isNow?'&#9632; ':'')+fmtDs(ex.startDate)+'→'+fmtDs(ex.endDate)+'</span>';
        }
        if(actEx.length>4)eh+='<span style="color:var(--dim)">+'+( actEx.length-4)+' más</span>';
        exclRow.innerHTML=eh;
      }else{exclRow.style.display='none';}
    }else{exclRow.style.display='none';}

    /* Latest poll */
    if(polls.length>0){
      var lp=polls[0];
      document.getElementById('lpTime').textContent=fmtTime(lp.createdAt);
      document.getElementById('lpStatus').innerHTML=badge(lp.status);
      var rawC=lp.rawDatesCount||lp.datesCount||0;
      var filtC=lp.datesCount||0;
      document.getElementById('lpDates').textContent=filtC+'/'+rawC+' fechas';
      var be=document.getElementById('lpBest');
      if(lp.earliestDate){
        be.textContent=fmtD(lp.earliestDate);
        be.style.color=cd2&&lp.earliestDate<cd2?'var(--green)':'var(--text)';
      }else if(lp.topDates&&lp.topDates.length>0){
        be.textContent=fmtD(lp.topDates[0])+' (raw)';
        be.style.color='var(--muted)';
      }else{
        be.textContent='--';
        be.style.color='var(--text)';
      }
      document.getElementById('lpMs').textContent=lp.responseTimeMs?lp.responseTimeMs+'ms':'--';
      document.getElementById('lpNode').innerHTML=fmtNode(lp);
      document.getElementById('lpRs').innerHTML=lp.rescheduleResult?badge(lp.rescheduleResult,lp.rescheduleResult==='success'?'success':'fail'):'<span style="color:var(--dim)">--</span>';
      /* Connection info (proxy attempt) */
      var lpConnRow=document.getElementById('lpConnRow');
      var lpConn=document.getElementById('lpConn');
      var ci=lp.connectionInfo;
      if(ci&&IS_WEBSHARE_BOT){
        lpConnRow.style.display='';
        var wIdx=WEBSHARE_IPS.indexOf(ci.proxyAttemptIp);
        var ipLabel=wIdx>=0?'W'+(wIdx+1):(ci.proxyAttemptIp?ci.proxyAttemptIp.split('.').slice(-1)[0]:'?');
        var ipColor=wIdx>=0?(WEBSHARE_COLORS[wIdx]||'#94A3B8'):'var(--muted)';
        var connHtml='<span style="color:'+ipColor+';font-weight:700">'+ipLabel+'</span>';
        if(ci.websharePoolSize){connHtml+='<span style="color:var(--dim)"> ·'+ci.websharePoolSize+'IPs</span>';}
        if(ci.errorSource&&ci.errorSource!=='embassy_block'){
          var srcLabel=ci.errorSource==='proxy_quota'?'quota':'infra';
          var srcColor=ci.errorSource==='proxy_quota'?'var(--amber)':'#f97316';
          connHtml+='<span style="color:'+srcColor+';font-size:8px;margin-left:4px;font-weight:700">'+srcLabel+'</span>';
        }
        lpConn.innerHTML=connHtml;
      }else{lpConnRow.style.display='none';}
      /* Filtered-out reason (P1) */
      var lpMR=document.getElementById('lpMotivoRow');
      if(lp.status==='filtered_out'&&lp.error){
        lpMR.style.display='';
        document.getElementById('lpMotivo').textContent=lp.error.substring(0,100);
      }else{lpMR.style.display='none';}
    }

    document.getElementById('cdPhase').textContent=polls.length>0?guessPhase():'--';

    /* Health panel */
    renderHealth(health);

    /* Proxy pool panel (webshare bots only) */
    startPoolRefresh(bot.proxyProvider==='webshare');

    /* Top 5 */
    var top5List=document.getElementById('top5List');
    var top5Empty=document.getElementById('top5Empty');
    if(summary.top5&&summary.top5.length>0){
      top5Empty.style.display='none';
      var th='';
      for(var i=0;i<summary.top5.length;i++){
        var t5=summary.top5[i];
        var ago5=Math.floor((Date.now()-new Date(t5.seenAt).getTime())/6e4);
        var agoStr=ago5<60?ago5+'m':Math.floor(ago5/60)+'h'+(ago5%60?String(ago5%60).padStart(2,'0')+'m':'');
        var better5=cd2&&t5.date<cd2;
        th+='<div class="top5-row"><span class="top5-rank">#'+(i+1)+'</span>';
        th+='<span class="top5-date" style="color:'+(better5?'var(--green)':'var(--bright)')+'">'+fmtD(t5.date)+'</span>';
        th+='<span class="appt-days">'+daysUntil(t5.date)+'</span>';
        th+='<span class="top5-ago">hace '+agoStr+'</span></div>';
      }
      top5List.innerHTML=th;
    }else{
      top5List.innerHTML='';top5Empty.style.display='';top5Empty.textContent='sin datos en 24h';
    }

    /* Chart */
    drawChart(polls,cd2,summary,chartMode);

    /* Poll table */
    document.getElementById('pollCount').textContent=polls.length;
    var tb=document.getElementById('pollTb');
    var pe=document.getElementById('pollEmpty');
    if(polls.length===0){tb.innerHTML='';pe.style.display=''}
    else{
      pe.style.display='none';
      var rows='';
      for(var i=0;i<Math.min(polls.length,25);i++){
        var p=polls[i];
        var pRawEarliest=p.topDates&&p.topDates.length>0?p.topDates[0]:null;
        var best=p.earliestDate?fmtDs(p.earliestDate):(pRawEarliest?'<span style="color:var(--muted)">'+fmtDs(pRawEarliest)+'</span>':'-');
        var bc=p.earliestDate&&cd2&&p.earliestDate<cd2?'color:var(--green)':'';
        var rb=p.rescheduleResult?' '+badge(p.rescheduleResult==='success'?'RS':'RF',p.rescheduleResult==='success'?'success':'fail'):'';
        var pRaw=p.rawDatesCount||p.datesCount||0;
        var pFilt=p.datesCount||0;
        var datesCell=pFilt+'/'+pRaw;
        var errTip=p.error&&(p.status==='tcp_blocked'||p.status==='error'||p.status==='soft_ban'||p.status==='econnrefused')?' <span onclick="showMsgOverlay('+JSON.stringify(p.error).replace(/"/g,'&quot;')+')" style="font-size:8px;color:var(--muted);cursor:pointer;text-decoration:underline dotted">'+escH(p.error.substring(0,40))+(p.error.length>40?'…':'')+'</span>':'';
        var statusBadge;
        if(p.status==='tcp_blocked'){
          var es=p.connectionInfo&&p.connectionInfo.errorSource;
          var cls=p.connectionInfo&&p.connectionInfo.blockClassification;
          if(es==='proxy_quota')
            statusBadge='<span class="b b-tcp_quota" title="Webshare bandwidth agotado (402)">tcp·quota</span>';
          else if(es==='proxy_infra')
            statusBadge='<span class="b b-tcp_infra" title="Proxy inalcanzable (ECONNREFUSED / tunnel caído)">tcp·infra</span>';
          else if(cls==='account_ban')
            statusBadge='<span class="b b-tcp_drop" title="Embajada cierra TCP con 0 bytes — pool agotado o IP directa baneada">tcp·drop</span>';
          else if(es==='embassy_block'||cls==='ip_ban')
            statusBadge='<span class="b b-tcp_embassy" title="IPs de proxy baneadas — rotando, recovery ~30-60min">tcp·embassy</span>';
          else
            statusBadge='<span class="b b-tcp_blocked" title="TCP bloqueado — causa desconocida (log histórico)">tcp_blocked</span>';
        }else{
          statusBadge=badge(p.status);
        }
        rows+='<tr><td style="color:var(--muted)">'+fmtTime(p.createdAt)+'</td><td>'+fmtNode(p)+'</td><td>'+statusBadge+errTip+rb+'</td><td>'+datesCell+'</td><td style="'+bc+'">'+best+'</td><td style="color:var(--muted)">'+(p.responseTimeMs||'-')+'</td></tr>';
      }
      tb.innerHTML=rows;
    }

    /* Reschedules */
    var rl=document.getElementById('rsList');
    var re=document.getElementById('rsEmpty');
    if(rss.length===0){rl.innerHTML='';re.style.display=''}
    else{
      re.style.display='none';
      var rh='';
      for(var i=0;i<rss.length;i++){
        var r=rss[i];var ok=r.success;
        rh+='<div class="rs-item"><div class="rs-dates">'+fmtDs(r.oldConsularDate)+' '+(r.oldConsularTime||'')+
          '<span class="rs-arrow">&rarr;</span><span style="color:'+(ok?'var(--green)':'var(--red)')+';font-weight:700">'
          +fmtDs(r.newConsularDate)+' '+r.newConsularTime+'</span> '+badge(ok?'OK':'FAIL',ok?'success':'fail')+
          '</div><div class="rs-meta">'+fmt(r.createdAt)+(ok&&r.error?' &mdash; <span style="color:var(--accent)">'+r.error.substring(0,60)+'</span>':!ok&&r.error?' &mdash; <span class="rs-err">'+r.error.substring(0,60)+'</span>':'')+'</div></div>';
      }
      rl.innerHTML=rh;
    }

    renderHeatmap(bot.casCache);
    renderCasChanges(casLogs);
    renderEvents(polls,rss,casLogs);
    renderBookableEvents(beRows||[]);
    lastExclusions=bot.excludedDateRanges||[];
    calPollList=null;tlSelDate=null;tlDots=[];
    var cp=getCalPolls();
    if(cp.length>0&&calIdx<cp.length)autoScrollToEarliestDate(cp[calIdx]);
    renderCalendar();
    renderTimelines();
  }catch(e){
    console.error('refresh err:',e);
  }
}

/* ── Chart toggle ── */
function setChartMode(m){
  chartMode=m;
  document.getElementById('ctRecent').className='ct-btn'+(m===0?' ct-on':'');
  document.getElementById('ct24h').className='ct-btn'+(m===1?' ct-on':'');
  drawChart(lastPolls,lastBot?lastBot.currentConsularDate:null,lastSummary,chartMode);
}

/* ── Trend Chart ── */
function drawChart(polls,currentDate,summary,mode){
  var canvas=document.getElementById('trendCanvas');
  var emptyEl=document.getElementById('chartEmpty');
  if(!canvas)return;
  var ctx=canvas.getContext('2d');
  var dpr=window.devicePixelRatio||1;
  var rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;
  ctx.scale(dpr,dpr);
  var W=rect.width,H=rect.height;

  /* Build data points based on mode */
  var pts=[];
  if(mode===1&&summary&&summary.buckets){
    for(var i=0;i<summary.buckets.length;i++){
      var b=summary.buckets[i];
      if(b.earliestDate)pts.push({x:new Date(b.t).getTime(),date:b.earliestDate});
    }
  }else{
    for(var i=polls.length-1;i>=0;i--){
      var p=polls[i];
      var ed=p.earliestDate||(p.topDates&&p.topDates.length?p.topDates[0]:null);
      if(ed&&(p.status==='ok'||p.status==='filtered_out'))pts.push({x:new Date(p.createdAt).getTime(),date:ed});
    }
  }
  if(pts.length<2){ctx.clearRect(0,0,W,H);emptyEl.style.display='';return}
  emptyEl.style.display='none';

  var today=new Date();today.setHours(0,0,0,0);var todayMs=today.getTime();
  function d2d(s){var q=s.split('-').map(Number);return Math.round((new Date(q[0],q[1]-1,q[2]).getTime()-todayMs)/864e5)}

  var currentDays=currentDate?d2d(currentDate):null;
  var data=pts.map(function(p){return{x:p.x,y:d2d(p.date),date:p.date}});

  var xMin=data[0].x,xMax=data[data.length-1].x;
  if(xMin===xMax)xMax=xMin+1;
  var yVals=data.map(function(d){return d.y});
  if(currentDays!==null)yVals.push(currentDays);
  var yMin=Math.min.apply(null,yVals)-3,yMax=Math.max.apply(null,yVals)+3;
  if(yMin===yMax){yMin-=5;yMax+=5}

  var pad={t:8,r:20,b:28,l:32};
  var cW=W-pad.l-pad.r,cH=H-pad.t-pad.b;
  function sx(v){return pad.l+(v-xMin)/(xMax-xMin)*cW}
  function sy(v){return pad.t+(v-yMin)/(yMax-yMin)*cH}

  ctx.clearRect(0,0,W,H);

  /* Grid */
  ctx.strokeStyle='rgba(255,255,255,0.03)';ctx.lineWidth=1;
  for(var i=0;i<=4;i++){var yy=pad.t+cH*i/4;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(W-pad.r,yy);ctx.stroke()}

  /* Reference line */
  if(currentDays!==null){
    var refY=sy(currentDays);
    ctx.strokeStyle='rgba(248,113,113,0.25)';ctx.setLineDash([3,3]);ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(pad.l,refY);ctx.lineTo(W-pad.r,refY);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='rgba(248,113,113,0.4)';ctx.font='8px monospace';ctx.textAlign='right';
    ctx.fillText('actual',W-pad.r,refY-3);
  }

  /* Area fill */
  ctx.beginPath();ctx.moveTo(sx(data[0].x),sy(yMax));
  for(var i=0;i<data.length;i++)ctx.lineTo(sx(data[i].x),sy(data[i].y));
  ctx.lineTo(sx(data[data.length-1].x),sy(yMax));ctx.closePath();
  var grad=ctx.createLinearGradient(0,pad.t,0,pad.t+cH);
  grad.addColorStop(0,'rgba(167,139,250,0.12)');grad.addColorStop(1,'rgba(167,139,250,0.01)');
  ctx.fillStyle=grad;ctx.fill();

  /* Glow */
  ctx.strokeStyle='rgba(167,139,250,0.12)';ctx.lineWidth=5;ctx.lineJoin='round';
  ctx.beginPath();
  for(var i=0;i<data.length;i++){if(i===0)ctx.moveTo(sx(data[i].x),sy(data[i].y));else ctx.lineTo(sx(data[i].x),sy(data[i].y))}
  ctx.stroke();

  /* Line */
  ctx.strokeStyle='#A78BFA';ctx.lineWidth=1.5;
  ctx.beginPath();
  for(var i=0;i<data.length;i++){if(i===0)ctx.moveTo(sx(data[i].x),sy(data[i].y));else ctx.lineTo(sx(data[i].x),sy(data[i].y))}
  ctx.stroke();

  /* Points */
  for(var i=0;i<data.length;i++){
    ctx.fillStyle='#A78BFA';ctx.beginPath();ctx.arc(sx(data[i].x),sy(data[i].y),2,0,Math.PI*2);ctx.fill();
  }

  /* Top 5 markers (24h mode only) */
  if(mode===1&&summary&&summary.top5&&summary.top5.length>0){
    for(var ti=0;ti<summary.top5.length;ti++){
      var t5=summary.top5[ti];
      var t5y=d2d(t5.date);
      var t5x=new Date(t5.seenAt).getTime();
      // Clamp to chart range
      if(t5x<xMin)t5x=xMin;if(t5x>xMax)t5x=xMax;
      var px=sx(t5x),py=sy(t5y);
      // Diamond
      var ds=4;
      ctx.fillStyle='#FCD34D';ctx.beginPath();
      ctx.moveTo(px,py-ds);ctx.lineTo(px+ds,py);ctx.lineTo(px,py+ds);ctx.lineTo(px-ds,py);ctx.closePath();ctx.fill();
      // Rank label
      ctx.fillStyle='rgba(252,211,77,0.7)';ctx.font='bold 7px monospace';ctx.textAlign='center';
      ctx.fillText('#'+(ti+1),px,py-ds-2);
    }
  }

  /* Y labels */
  ctx.fillStyle='rgba(255,255,255,0.15)';ctx.font='8px monospace';ctx.textAlign='right';
  for(var i=0;i<=4;i++){
    var v=Math.round(yMin+(yMax-yMin)*i/4);
    ctx.fillText(v+'d',pad.l-3,pad.t+cH*i/4+3);
  }

  /* X labels */
  ctx.fillStyle='rgba(255,255,255,0.15)';ctx.font='8px monospace';ctx.textAlign='center';
  var xLabels=5;
  for(var i=0;i<xLabels;i++){
    var xv=xMin+(xMax-xMin)*i/(xLabels-1);
    var xDate=new Date(xv);
    var bogStr=xDate.toLocaleString('es-CO',Object.assign({},TZ,{weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}));
    // "jue., 09:00" → "jue 09:00"
    bogStr=bogStr.replace('.','').replace(',','');
    var lx=pad.l+cW*i/(xLabels-1);
    ctx.fillText(bogStr,lx,H-pad.b+12);
  }
}

/* ── Proxy Pool Panel ── */
// Derived from poll_logs.connectionInfo (cross-process: API server ≠ trigger worker)
var poolRefreshInterval=null;
function startPoolRefresh(isWebshare){
  var card=document.getElementById('proxyPoolCard');
  if(!isWebshare){card.style.display='none';if(poolRefreshInterval){clearInterval(poolRefreshInterval);poolRefreshInterval=null;}return;}
  card.style.display='';
  fetchJ(API+'/bots/'+BID+'/proxy-pool?hours=2').then(renderPool).catch(function(){});
  if(!poolRefreshInterval)poolRefreshInterval=setInterval(function(){fetchJ(API+'/bots/'+BID+'/proxy-pool?hours=2').then(renderPool).catch(function(){});},15000);
}
function renderPool(state){
  var ppEmpty=document.getElementById('ppEmpty');
  var ppIps=document.getElementById('ppIps');
  if(!state||!state.ips||Object.keys(state.ips).length===0){
    ppEmpty.style.display='';ppIps.innerHTML='';
    document.getElementById('ppSummary').textContent='sin datos ('+((state&&state.windowHours)||2)+'h)';
    return;
  }
  ppEmpty.style.display='none';
  var ips=state.ips;
  var ipKeys=Object.keys(ips).filter(function(k){return k!=='direct';});
  var healthyCount=ipKeys.filter(function(k){return ips[k].tcpBlockedRate<=10;}).length;
  var badCount=ipKeys.filter(function(k){return ips[k].tcpBlockedRate>30;}).length;
  if(state.quotaExhausted){
    document.getElementById('ppSummary').innerHTML='<span style="color:var(--amber);font-weight:700">⚠ QUOTA AGOTADA (402)</span>';
  }else{
    document.getElementById('ppSummary').textContent='ok: '+healthyCount+'/'+ipKeys.length+' · '+state.totalPolls+' polls/'+state.windowHours+'h'+(badCount?' · '+badCount+' degraded':'');
  }

  var html='';
  // Sort by tcpBlockedRate descending (worst first)
  ipKeys.sort(function(a,b){return ips[b].tcpBlockedRate-ips[a].tcpBlockedRate;});
  for(var i=0;i<ipKeys.length;i++){
    var ip=ipKeys[i];
    var h=ips[ip];
    var wIdx=WEBSHARE_IPS.indexOf(ip);
    var label=wIdx>=0?'W'+(wIdx+1):ip.split('.').pop();
    var color=wIdx>=0?(WEBSHARE_COLORS[wIdx]||'#94A3B8'):'var(--text)';
    var okPct=h.okRate;
    var barColor=okPct>=90?'var(--green)':okPct>=70?'var(--amber)':'var(--red)';
    var dotCls=okPct>=90?'closed':okPct>=70?'half_open':'open';
    var latStr=h.avgLatMs?h.avgLatMs+'ms':'—';
    var ageSec=h.lastSeen?Math.round((Date.now()-new Date(h.lastSeen).getTime())/1000):null;
    var ageStr=ageSec===null?'—':ageSec<120?ageSec+'s ago':Math.floor(ageSec/60)+'m ago';
    html+='<div class="pp-ip-row">';
    html+='<span class="pp-dot '+dotCls+'"></span>';
    html+='<span class="pp-ip-name" style="color:'+color+'">'+label+'</span>';
    var blkHtml='';
    var tb=h.tcpBreakdown;
    if(tb&&h.tcpBlocked>0){
      if(tb.proxyQuota>0)blkHtml+='<span style="color:var(--amber);font-weight:700" title="Bandwidth agotado">quota:'+tb.proxyQuota+'</span> ';
      if(tb.embassyBlock>0)blkHtml+='<span style="color:var(--red)" title="IP baneada por embajada">emb:'+tb.embassyBlock+'</span> ';
      if(tb.proxyInfra>0)blkHtml+='<span style="color:#f97316" title="Proxy caído">infra:'+tb.proxyInfra+'</span> ';
      if(tb.unknown>0)blkHtml+='<span style="color:var(--muted)">?:'+tb.unknown+'</span>';
      blkHtml=blkHtml.trim()||('<span style="color:var(--muted)">blk:'+h.tcpBlockedRate+'%</span>');
    }else if(h.tcpBlocked>0){
      blkHtml='<span style="color:var(--muted)">blk:'+h.tcpBlockedRate+'%</span>';
    }
    if(blkHtml)html+='<span style="font-size:9px">'+blkHtml+'</span>';
    else html+='<span style="font-size:9px;color:var(--muted)">blk:0%</span>';
    html+='<span style="font-size:9px;color:var(--muted)">'+latStr+'</span>';
    html+='<span style="font-size:9px;color:var(--dim)">'+h.polls+'p</span>';
    html+='<div class="pp-bar-wrap"><div class="pp-bar"><div class="pp-bar-fill" style="width:'+okPct+'%;background:'+barColor+'"></div></div></div>';
    html+='<span class="pp-stat">'+ageStr+'</span>';
    html+='</div>';
  }
  document.getElementById('ppIps').innerHTML=html;
  document.getElementById('ppEvents').style.display='none';
}

/* ── Health Panel ── */
/* Compute health client-side from polls array (eliminates /health endpoint DB query) */
function computeHealth(polls,windowMinutes){
  if(!polls||polls.length===0)return null;
  var cutoff=Date.now()-windowMinutes*60000;
  var recent=polls.filter(function(p){return new Date(p.createdAt).getTime()>=cutoff;});
  if(recent.length===0)return null;
  var windowMs=windowMinutes*60000;
  var chainMap={},ipMap={};
  for(var i=0;i<recent.length;i++){
    var p=recent[i];
    var chain=p.chainId||'unknown';
    var ip=p.publicIp||'unknown';
    var latency=p.responseTimeMs||0;
    var status=p.status||'unknown';
    var ts=new Date(p.createdAt).toISOString();
    var isSuccess=status==='ok'||status==='filtered_out';
    /* chain */
    if(!chainMap[chain])chainMap[chain]={polls:0,latencySum:0,latencyCount:0,lastPollAt:ts,statuses:{}};
    var ch=chainMap[chain];
    ch.polls++;
    if(latency>0){ch.latencySum+=latency;ch.latencyCount++;}
    ch.statuses[status]=(ch.statuses[status]||0)+1;
    /* ip */
    if(!ipMap[ip])ipMap[ip]={polls:0,latencySum:0,latencyCount:0,chain:chain,successCount:0,tcpBlockedCount:0,lastSeenAt:ts,provider:p.provider||'unknown'};
    var ip2=ipMap[ip];
    ip2.polls++;
    if(latency>0){ip2.latencySum+=latency;ip2.latencyCount++;}
    if(isSuccess)ip2.successCount++;
    if(status==='tcp_blocked')ip2.tcpBlockedCount++;
  }
  /* build chains */
  var chains={};
  var chainKeys=Object.keys(chainMap);
  for(var ci=0;ci<chainKeys.length;ci++){
    var cn=chainKeys[ci];var cv=chainMap[cn];
    chains[cn]={polls:cv.polls,pollsPerMin:+(cv.polls/(windowMs/60000)).toFixed(1),avgLatencyMs:cv.latencyCount>0?Math.round(cv.latencySum/cv.latencyCount):0,lastPollAt:cv.lastPollAt,statuses:cv.statuses};
  }
  /* build ips */
  var ips={};
  var ipKeys2=Object.keys(ipMap);
  for(var ii=0;ii<ipKeys2.length;ii++){
    var ik=ipKeys2[ii];var iv=ipMap[ik];
    ips[ik]={polls:iv.polls,pollsPerMin:+(iv.polls/(windowMs/60000)).toFixed(1),avgLatencyMs:iv.latencyCount>0?Math.round(iv.latencySum/iv.latencyCount):0,successRate:iv.polls>0?+(iv.successCount/iv.polls*100).toFixed(0):0,tcpBlockedCount:iv.tcpBlockedCount,tcpBlockedRate:iv.polls>0?+(iv.tcpBlockedCount/iv.polls*100).toFixed(1):0,chain:iv.chain,lastSeenAt:iv.lastSeenAt,provider:iv.provider};
  }
  /* alerts */
  var alerts=[];
  var threeMinAgo=Date.now()-3*60000;
  for(var ai=0;ai<chainKeys.length;ai++){
    var an=chainKeys[ai];var av=chainMap[an];
    if(new Date(av.lastPollAt).getTime()<threeMinAgo){
      var mins=Math.round((Date.now()-new Date(av.lastPollAt).getTime())/60000);
      alerts.push({type:'chain_silent',message:an+' chain: no polls in '+mins+'min',severity:'warning'});
    }
  }
  for(var ri=0;ri<ipKeys2.length;ri++){
    var rk=ipKeys2[ri];var rv=ipMap[rk];
    var rate=rv.polls/(windowMs/60000);
    if(rate>15)alerts.push({type:'rate_high',message:rk+': '+rate.toFixed(1)+' req/min (limit ~20)',severity:rate>18?'critical':'warning'});
    if(rv.tcpBlockedCount>0){
      var br=rv.tcpBlockedCount/rv.polls;
      if(rv.tcpBlockedCount>=3||br>0.05){
        var pct=(br*100).toFixed(0);
        var lbl=rv.tcpBlockedCount>=3?'circuit breaker active':pct+'% bloqueo';
        alerts.push({type:'ip_block_rate_high',message:rk+': '+rv.tcpBlockedCount+' tcp_blocked/'+rv.polls+' polls ('+pct+'%) — '+lbl,severity:br>0.15?'critical':'warning'});
      }
    }
  }
  return{windowMinutes:windowMinutes,totalPolls:recent.length,ratePerMin:+(recent.length/(windowMs/60000)).toFixed(1),chains:chains,ips:ips,alerts:alerts};
}

function renderHealth(h){
  var el=document.getElementById('healthEmpty');
  var cEl=document.getElementById('healthChains');
  var aEl=document.getElementById('healthAlerts');
  var iEl=document.getElementById('healthIps');
  var rEl=document.getElementById('healthRate');
  if(!h||!h.chains){
    el.style.display='';el.textContent='sin datos';cEl.innerHTML='';aEl.innerHTML='';iEl.innerHTML='';rEl.textContent='';return;
  }
  el.style.display='none';
  rEl.textContent=h.ratePerMin+'/min ('+h.totalPolls+' polls, '+h.windowMinutes+'min)';

  // Chains
  var ch='';
  var chainNames=Object.keys(h.chains).sort();
  for(var ci=0;ci<chainNames.length;ci++){
    var cn=chainNames[ci];
    var cv=h.chains[cn];
    var dotColor=cv.pollsPerMin>0?'var(--green)':'var(--red)';
    var lastAgo=Math.round((Date.now()-new Date(cv.lastPollAt).getTime())/60000);
    var lastStr=lastAgo<1?'<1m':lastAgo+'m ago';
    var sts='';
    var stKeys=Object.keys(cv.statuses);
    for(var si=0;si<stKeys.length;si++){
      var sk=stKeys[si];var sv=cv.statuses[sk];
      var sc=sk==='ok'?'var(--green)':sk==='filtered_out'?'var(--muted)':sk==='tcp_blocked'?'var(--red)':'var(--amber)';
      var bold=sk==='tcp_blocked'&&sv>0?'font-weight:700;':'';
      var tip=sk==='tcp_blocked'?(' title="retry +30min · circuit breaker: ≥3/20min → 45min cooldown"'):'';
      sts+='<span style="color:'+sc+';'+bold+'"'+tip+'>'+sk+':'+sv+'</span> ';
    }
    ch+='<div class="hlth-chain">';
    ch+='<span class="hlth-dot" style="background:'+dotColor+'"></span>';
    ch+='<span class="hlth-lbl">'+cn+'</span>';
    ch+='<span class="hlth-stat"><b>'+cv.pollsPerMin+'</b>/min · '+cv.avgLatencyMs+'ms · '+lastStr+'</span>';
    ch+='<span class="hlth-stat" style="margin-left:auto">'+sts+'</span>';
    ch+='</div>';
  }
  cEl.innerHTML=ch;

  // Alerts
  var ah='';
  if(h.alerts&&h.alerts.length>0){
    for(var ai=0;ai<h.alerts.length;ai++){
      var al=h.alerts[ai];
      ah+='<div class="hlth-alert hlth-alert-'+al.severity+'">'+al.message+'</div>';
    }
  }
  aEl.innerHTML=ah;

  // IPs table
  var ipKeys=Object.keys(h.ips);
  if(ipKeys.length===0){iEl.innerHTML='';return;}
  ipKeys.sort(function(a,b){return h.ips[b].polls-h.ips[a].polls;});
  var it='<table class="hlth-ip-tbl"><thead><tr><th>ip</th><th>chain</th><th>/min</th><th>ms</th><th>ok%</th><th title="tcp_blocked (circuit breaker: ≥3 fallos/20min → pausa 45min)">blk</th></tr></thead><tbody>';
  for(var ii=0;ii<ipKeys.length;ii++){
    var ik=ipKeys[ii];
    var iv=h.ips[ik];
    var wIdx2=WEBSHARE_IPS.indexOf(ik);
    var ipLabel;
    if(iv.chain==='cloud'){
      ipLabel='<span style="color:#22D3EE;font-weight:700" title="Cloud Direct ('+ik+')">CLD</span>';
    } else if(wIdx2>=0){
      var wc2=WEBSHARE_COLORS[wIdx2]||'#94A3B8';
      ipLabel='<span style="color:'+wc2+';font-weight:700" title="Webshare #'+(wIdx2+1)+' ('+ik+')">W'+(wIdx2+1)+'</span>';
    } else {
      ipLabel=IS_WEBSHARE_BOT
        ?'<span style="color:#94A3B8;font-weight:700" title="Webshare dynamic ('+ik+')">Wsh</span>'
        :'<span style="color:#FBBF24;font-weight:700" title="RPi Direct ('+ik+')">RPi</span>';
    }
    var okPct=iv.successRate;
    var okColor=okPct>=90?'var(--green)':okPct>=70?'var(--amber)':'var(--red)';
    var blkCount=iv.tcpBlockedCount||0;
    var blkRate=iv.tcpBlockedRate||0;
    var blkColor=blkCount===0?'var(--muted)':blkRate>15?'var(--red)':blkRate>5?'var(--amber)':'var(--dim)';
    var blkTip=blkCount>=3?'circuit breaker activo (pausa 45min en efecto)':'tcp_blocked: '+blkCount+' polls';
    it+='<tr>';
    it+='<td>'+ipLabel+'</td>';
    it+='<td style="color:var(--muted)">'+iv.chain+'</td>';
    it+='<td><b>'+iv.pollsPerMin+'</b></td>';
    it+='<td>'+iv.avgLatencyMs+'</td>';
    it+='<td><div class="hlth-bar"><div class="hlth-bar-fill" style="width:'+okPct+'%;background:'+okColor+'"></div></div><span style="color:'+okColor+'">'+okPct+'%</span></td>';
    it+='<td style="color:'+blkColor+'" title="'+blkTip+'">'+blkCount+(blkRate>0?'<span style="color:var(--muted);font-size:8px"> '+blkRate+'%</span>':'')+'</td>';
    it+='</tr>';
  }
  it+='</tbody></table>';
  iEl.innerHTML=it;
}

/* ── CAS Heatmap ── */
function renderHeatmap(cc){
  var el=document.getElementById('heatmap');
  var ageEl=document.getElementById('hmAge');
  var availEl=document.getElementById('hmAvail');
  var fullEl=document.getElementById('hmFull');

  if(!cc||!cc.entries||cc.entries.length===0){
    ageEl.textContent='sin cache';ageEl.style.color='var(--dim)';
    availEl.textContent='--';fullEl.textContent='--';
    el.innerHTML='<div class="empty">prefetch-cas no ha corrido</div>';
    return;
  }

  ageEl.textContent=cc.ageMin+'m';
  ageEl.style.color=cc.ageMin>30?'var(--red)':cc.ageMin>15?'var(--amber)':'var(--green)';
  availEl.textContent=cc.availableDates||cc.totalDates-cc.fullDates;
  fullEl.textContent=cc.fullDates;

  var HOURS=[7,8,9,10,11,12,13,14,15,16,17];
  var lookup={};
  for(var i=0;i<cc.entries.length;i++){
    var e=cc.entries[i];
    var hc={};for(var h=0;h<HOURS.length;h++)hc[HOURS[h]]=0;
    if(e.times&&e.slots>0){
      for(var j=0;j<e.times.length;j++){
        var hr=parseInt(e.times[j].split(':')[0]);
        if(hc[hr]!==undefined)hc[hr]++;
      }
    }
    lookup[e.date]={slots:e.slots,hc:hc};
  }

  var now=new Date();var days=[];
  for(var i=1;i<=30;i++){
    var d=new Date(now.getTime()+i*864e5);
    days.push(d.toLocaleDateString('sv-SE',TZ));
  }

  var html='<div class="hm-grid">';
  html+='<div class="hm-corner"></div>';
  for(var h=0;h<HOURS.length;h++)html+='<div class="hm-hour">'+HOURS[h]+'</div>';

  for(var i=0;i<days.length;i++){
    var ds=days[i];var parts=ds.split('-').map(Number);
    var dt=new Date(parts[0],parts[1]-1,parts[2]);var wd=dt.getDay();
    var lbl=parts[2]+'/'+parts[1];
    html+='<div class="hm-lbl'+(wd===0?' sun':'')+'">'+lbl+' <span style="font-size:7px;margin-left:1px">'+DSE[wd]+'</span></div>';

    var data=lookup[ds];
    for(var h=0;h<HOURS.length;h++){
      if(!data){html+='<div class="hm-cell hm-c-none"></div>'}
      else if(data.slots===-1){html+='<div class="hm-cell hm-c-err"></div>'}
      else if(data.slots===0){html+='<div class="hm-cell hm-c-full"></div>'}
      else{
        var cnt=data.hc[HOURS[h]]||0;
        if(cnt===0){html+='<div class="hm-cell hm-c-0"></div>'}
        else{
          var alpha=0.2+Math.min(cnt/4,1)*0.6;
          html+='<div class="hm-cell" style="background:rgba(96,165,250,'+alpha.toFixed(2)+')"></div>';
        }
      }
    }
  }
  html+='</div>';

  html+='<div class="hm-legend">';
  html+='<span><span class="hm-sw" style="background:rgba(96,165,250,.25)"></span>pocos</span>';
  html+='<span><span class="hm-sw" style="background:rgba(96,165,250,.55)"></span>medio</span>';
  html+='<span><span class="hm-sw" style="background:rgba(96,165,250,.8)"></span>lleno</span>';
  html+='<span><span class="hm-sw" style="background:rgba(248,113,113,.15)"></span>full</span>';
  html+='<span><span class="hm-sw" style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06)"></span>n/a</span>';
  html+='</div>';

  el.innerHTML=html;
}

function guessPhase(){
  var now=new Date();var bog=new Date(now.toLocaleString('en-US',TZ));
  var h=bog.getHours(),m=bog.getMinutes(),d=bog.getDay();
  /* es-co: martes 9am, es-pe: miercoles 12pm */
  var locale=lastBot?lastBot.locale:'es-co';
  var dropDay=2,dropH=9; /* default: es-co */
  if(locale&&locale.indexOf('pe')>=0){dropDay=3;dropH=12}
  if(d===dropDay){
    if((h===dropH-1&&m>=58)||(h===dropH&&m<8))return'SUPER-CRITICAL';
    if(h===dropH&&m>=8||(h>dropH&&h<dropH+1))return'BURST';
    if(h>=dropH-4&&h<dropH)return'PRE-WARM';
    if(h>=dropH+1&&h<dropH+2)return'POST-BURST';
  }
  /* Show strategy hint */
  var envs=lastBot?lastBot.pollEnvironments||['dev']:['dev'];
  var strategy=envs.length>1?'dual':'single';
  return'NORMAL ('+strategy+')';
}

function renderActions(st){
  var el=document.getElementById('actions');
  var ed=document.getElementById('emergDiv');
  if(st==='active'){
    el.style.display='flex';
    el.innerHTML='<button class="btn btn-r" onclick="botAct(\\'pause\\')">pausar</button>';
  }else if(st==='paused'){
    el.style.display='flex';
    el.innerHTML='<button class="btn btn-g" onclick="botAct(\\'resume\\')">reanudar</button>';
  }else if(st==='error'||st==='login_required'||st==='created'){
    el.style.display='flex';
    el.innerHTML='<button class="btn btn-c" onclick="botAct(\\'activate\\')">activar</button>';
  }else{el.style.display='none';}
  ed.style.display=(st==='active'||st==='error'||st==='login_required')?'':'none';
}

async function emergAct(a){
  var labels={'force-login':'forzar login (dispara login-visa)','restart-chain':'restart cadena de polling'};
  if(!confirm('\\u00bfEjecutar: '+labels[a]+'?'))return;
  var btns=document.querySelectorAll('#emergDiv .btn');
  for(var i=0;i<btns.length;i++){btns[i].disabled=true;}
  try{
    var r=await fetch(API+'/bots/'+BID+'/'+a,{method:'POST'});
    var d=await r.json();
    if(r.ok)showToast(a==='force-login'?'login iniciado':'cadena reiniciada',true);
    else showToast(d.error||'error '+r.status,false);
  }catch(e){showToast('error de red',false);}
  setTimeout(refresh,1500);
}

async function botAct(a){
  var btns=document.querySelectorAll('#actions .btn');
  for(var i=0;i<btns.length;i++){btns[i].disabled=true;btns[i].textContent+='...'}
  try{
    var r=await fetch(API+'/bots/'+BID+'/'+a,{method:'POST'});
    var d=await r.json();
    if(r.ok)showToast(a==='pause'?'bot pausado':a==='resume'?'bot reanudado':'bot activado',true);
    else showToast(d.error||'error '+r.status,false);
  }catch(e){showToast('error de red',false)}
  setTimeout(refresh,1000);
}

function showToast(msg,ok){
  var t=document.getElementById('toast');
  t.textContent=msg;t.className='toast show '+(ok?'toast-ok':'toast-err');
  setTimeout(function(){t.className='toast'},3000);
}

/* ── CAS Changes ── */
function renderCasChanges(logs){
  var el=document.getElementById('casChanges');
  var emptyEl=document.getElementById('casChgEmpty');
  if(!el)return;

  // Collect all changes from recent logs
  var allChanges=[];
  for(var i=0;i<logs.length;i++){
    var log=logs[i];
    var ch=log.changesJson;
    if(ch&&ch.length>0){
      for(var j=0;j<ch.length;j++){
        allChanges.push({change:ch[j],at:log.createdAt});
      }
    }
  }

  if(allChanges.length===0){
    el.innerHTML='';emptyEl.style.display='';
    return;
  }
  emptyEl.style.display='none';

  var LABELS={appeared:'aparecio',went_full:'full',disappeared:'desapar.',slots_changed:'cambio'};
  var html='';
  for(var i=0;i<allChanges.length;i++){
    var c=allChanges[i].change;
    var at=allChanges[i].at;
    var d=c.date;var day=dow(d);
    var label=LABELS[c.type]||c.type;
    var from=c.oldSlots===-1?'--':c.oldSlots===0?'0':c.oldSlots;
    var to=c.newSlots===-1?'--':c.newSlots;
    var toColor=c.type==='appeared'?'var(--green)':c.type==='went_full'||c.type==='disappeared'?'var(--red)':c.type==='slots_changed'?'var(--blue)':'var(--muted)';

    html+='<div class="chg-item">';
    html+='<span class="chg-date">'+fmtDs(d)+'</span>';
    html+='<span class="chg-dow">'+day+'</span>';
    html+='<span class="chg-badge chg-'+c.type+'">'+label+'</span>';
    html+='<span class="chg-slots">'+from+'<span class="chg-arrow">&rarr;</span><span style="color:'+toColor+';font-weight:700">'+to+'</span></span>';
    // Confidence badge
    if(c.confidence==='low')html+='<span class="chg-conf chg-conf-low">?</span>';
    else if(c.confidence==='error')html+='<span class="chg-conf chg-conf-error">err</span>';
    html+='<span class="chg-time">'+fmtTime(at)+'</span>';
    // Time diffs row
    var added=(c.addedTimes||[]);var removed=(c.removedTimes||[]);
    if(added.length>0||removed.length>0){
      var MAX_T=6;var thtml='<span class="chg-times">';
      if(added.length>0){
        var show=added.slice(0,MAX_T);
        for(var k=0;k<show.length;k++)thtml+='<span class="chg-t-add">+'+show[k]+'</span> ';
        if(added.length>MAX_T)thtml+='<span class="chg-t-add">+'+(added.length-MAX_T)+' mas</span> ';
      }
      if(removed.length>0){
        var show2=removed.slice(0,MAX_T);
        for(var k=0;k<show2.length;k++)thtml+='<span class="chg-t-rm">-'+show2[k]+'</span> ';
        if(removed.length>MAX_T)thtml+='<span class="chg-t-rm">-'+(removed.length-MAX_T)+' mas</span> ';
      }
      thtml+='</span>';html+=thtml;
    }
    html+='</div>';
  }
  el.innerHTML=html;
}

/* ── Events Timeline ── */
function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function showMsgOverlay(msg){
  var ov=document.getElementById('msgOverlay');
  if(!ov){
    ov=document.createElement('div');
    ov.id='msgOverlay';
    ov.style.cssText='position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);padding:20px;cursor:pointer';
    ov.onclick=function(){ov.remove()};
    document.body.appendChild(ov);
  }
  ov.innerHTML='<div style="background:var(--card,#1a1a1a);border:1px solid var(--border,#333);border-radius:6px;padding:16px 20px;max-width:560px;width:100%;position:relative" onclick="event.stopPropagation()">'+
    '<div style="font-size:9px;color:var(--muted,#666);margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em">Mensaje completo</div>'+
    '<pre style="font-family:monospace;font-size:11px;color:var(--text,#e5e5e5);white-space:pre-wrap;word-break:break-all;margin:0">'+escH(msg)+'</pre>'+
    '<div style="margin-top:12px;font-size:9px;color:var(--muted,#666);text-align:right">tap fuera para cerrar</div>'+
    '</div>';
  if(!document.getElementById('msgOverlay'))document.body.appendChild(ov);
}

/* ── Event filter state ── */
var evFilterState={all:true,reschedule:true,error:true,session:true,cas:true};
var lastEvData=null;
(function(){
  var btns=document.querySelectorAll('.ev-flt');
  for(var i=0;i<btns.length;i++){
    btns[i].addEventListener('click',function(e){
      e.stopPropagation();
      var f=this.getAttribute('data-f');
      if(f==='all'){
        var allOn=evFilterState.all;
        for(var k in evFilterState)evFilterState[k]=!allOn;
        var bs=document.querySelectorAll('.ev-flt');
        for(var j=0;j<bs.length;j++)bs[j].classList.toggle('on',!allOn);
      }else{
        evFilterState[f]=!evFilterState[f];
        this.classList.toggle('on',evFilterState[f]);
        var anyOff=false;for(var k in evFilterState)if(k!=='all'&&!evFilterState[k])anyOff=true;
        evFilterState.all=!anyOff;
        document.querySelector('.ev-flt[data-f="all"]').classList.toggle('on',!anyOff);
      }
      if(lastEvData)renderEvents(lastEvData.polls,lastEvData.rss,lastEvData.casLogs);
    });
  }
})();

/* Get Bogota date string for grouping */
function evDateKey(iso){return new Date(iso).toLocaleDateString('en-CA',TZ)}
function evDateLabel(key){
  var today=new Date().toLocaleDateString('en-CA',TZ);
  var y=new Date(Date.now()-864e5).toLocaleDateString('en-CA',TZ);
  if(key===today)return'hoy';
  if(key===y)return'ayer';
  var p=key.split('-').map(Number);
  var m=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  var dt=new Date(p[0],p[1]-1,p[2]);
  return DSE[dt.getDay()]+' '+p[2]+' '+m[p[1]-1];
}

function renderEvents(polls,rss,casLogs){
  lastEvData={polls:polls,rss:rss,casLogs:casLogs};
  var el=document.getElementById('evList');
  var emptyEl=document.getElementById('evEmpty');
  if(!el)return;

  var events=[];

  /* ── From poll_logs ── */
  for(var i=0;i<polls.length;i++){var p=polls[i];
    /* Re-login */
    if(p.reloginHappened){
      events.push({t:p.createdAt,type:'relogin',cat:'session',label:'RE-LOGIN',
        sum:'Sesion renovada',body:''});
    }
    /* Session expired */
    if(p.status==='session_expired'){
      events.push({t:p.createdAt,type:'session_expired',cat:'session',label:'SESION EXP',
        sum:escH((p.error||'Sesion expirada').substring(0,80)),
        body:p.error?'<div class="ev-err">'+escH(p.error)+'</div>':''});
    }
    /* Soft ban */
    if(p.status==='soft_ban'){
      events.push({t:p.createdAt,type:'soft_ban',cat:'error',label:'SOFT BAN',
        sum:'API retorno 0 fechas (rate limit)',body:''});
    }
    /* TCP block */
    if(p.status==='tcp_blocked'||p.status==='econnrefused'){
      events.push({t:p.createdAt,type:'tcp_blocked',cat:'error',label:'TCP BLOCK',
        sum:escH((p.error||'ECONNREFUSED').substring(0,80))+'<span style="color:var(--muted);font-size:8px"> · retry +30m</span>',
        body:(p.error?'<div class="ev-err">'+escH(p.error)+'</div>':'')+'<div style="font-size:8px;color:var(--muted);margin-top:4px">Backoff: 1°→30min · 2°→45min · 3°+→60min. Circuit breaker: ≥3 en 20min → IP excluida 45min.</div>'});
    }
    /* Generic errors (not already covered) */
    if(p.error&&p.status!=='session_expired'&&p.status!=='tcp_blocked'&&p.status!=='econnrefused'&&p.status!=='soft_ban'&&p.status!=='ok'){
      events.push({t:p.createdAt,type:'error',cat:'error',label:'ERROR',
        sum:'<code style="font-size:9px">'+escH(p.status)+'</code> '+escH(p.error.substring(0,70)),
        body:'<div class="ev-err">'+escH(p.error)+'</div>'+
          '<div style="margin-top:4px"><span class="ev-kv"><span class="ev-k">latencia: </span><span class="ev-v">'+(p.responseTimeMs||'?')+'ms</span></span>'+
          '<span class="ev-kv"><span class="ev-k">provider: </span><span class="ev-v">'+(p.provider||'?')+'</span></span></div>'});
    }
    /* Reschedule fail from poll (no detail table — rescheduleDetails omitted to reduce egress) */
    if(p.rescheduleResult&&p.rescheduleResult!=='success'){
      /* Skip if there's a matching reschedule_log within 30s */
      var ts=new Date(p.createdAt).getTime();var dup=false;
      for(var j=0;j<rss.length;j++){if(Math.abs(new Date(rss[j].createdAt).getTime()-ts)<30000){dup=true;break}}
      if(!dup){
        events.push({t:p.createdAt,type:'reschedule_fail',cat:'reschedule',label:'RSCH FAIL',
          sum:escH(p.rescheduleResult),body:''});
      }
    }
    /* Poll found better date but didn't reschedule */
    if(p.status==='ok'&&p.rescheduleResult&&p.rescheduleResult==='bot_not_active'){
      events.push({t:p.createdAt,type:'better_date',cat:'reschedule',label:'MEJOR FECHA',
        sum:fmtD(p.earliestDate)+' detectada (bot inactivo)',body:''});
    }
  }

  /* ── From reschedule_logs ── */
  for(var i=0;i<rss.length;i++){var r=rss[i];
    var bH='<div class="ev-rsch"><div class="ev-rsch-dates">';
    bH+='<span class="ev-rsch-old">'+fmtD(r.oldConsularDate)+' '+(r.oldConsularTime||'')+'</span>';
    bH+='<span class="ev-rsch-arrow">&rarr;</span>';
    bH+='<span class="ev-rsch-new'+(r.success?'':' fail')+'">'+fmtD(r.newConsularDate)+' '+r.newConsularTime+'</span>';
    bH+='</div>';
    bH+='<div class="ev-rsch-cas">CAS: '+fmtD(r.newCasDate)+' '+r.newCasTime;
    if(r.oldCasDate)bH+=' <span style="color:var(--dim)">(antes: '+fmtDs(r.oldCasDate)+' '+(r.oldCasTime||'')+')</span>';
    bH+='</div></div>';
    if(r.success&&r.error)bH+='<div style="font-size:9px;color:var(--accent);margin-top:4px"><code>'+escH(r.error)+'</code></div>';
    else if(r.error)bH+='<div class="ev-err">'+escH(r.error)+'</div>';
    events.push({t:r.createdAt,type:r.success?'reschedule_ok':'reschedule_fail',cat:'reschedule',
      label:r.success?'REAGENDADO':'RSCH FAIL',
      sum:(r.success?'':'FALLO ')+fmtDs(r.oldConsularDate)+' &rarr; '+fmtDs(r.newConsularDate)+' '+r.newConsularTime,
      body:bH,open:true});
  }

  /* ── From cas_prefetch_logs ── */
  for(var i=0;i<casLogs.length;i++){var cl=casLogs[i];
    var ch=cl.changesJson||[];
    var appeared=0,wentFull=0,disappeared=0,slotsChanged=0;
    for(var j=0;j<ch.length;j++){
      if(ch[j].type==='appeared')appeared++;
      else if(ch[j].type==='went_full')wentFull++;
      else if(ch[j].type==='disappeared')disappeared++;
      else slotsChanged++;
    }
    var parts=[];
    if(appeared)parts.push('+'+appeared+' nuevas');
    if(wentFull)parts.push(wentFull+' full');
    if(disappeared)parts.push(disappeared+' desapar.');
    if(slotsChanged)parts.push(slotsChanged+' cambios');
    var sumText=cl.totalDates+' fechas, '+cl.lowDates+' low'+(cl.fullDates?', '+cl.fullDates+' full':'');
    if(parts.length)sumText+=' | '+parts.join(', ');
    if(cl.error)sumText+=' | ERROR';

    var casBody='<div style="margin-bottom:4px"><span class="ev-kv"><span class="ev-k">duracion: </span><span class="ev-v">'+Math.round(cl.durationMs/1000)+'s</span></span>';
    casBody+='<span class="ev-kv"><span class="ev-k">requests: </span><span class="ev-v">'+cl.requestCount+'</span></span></div>';
    if(cl.error)casBody+='<div class="ev-err">'+escH(cl.error)+'</div>';
    if(ch.length>0){
      var LABELS={appeared:'nueva',went_full:'FULL',disappeared:'desapar.',slots_changed:'cambio'};
      var COLORS={appeared:'var(--green)',went_full:'var(--red)',disappeared:'var(--muted)',slots_changed:'#60a5fa'};
      casBody+='<div class="ev-cas-ch">';
      for(var j=0;j<Math.min(ch.length,10);j++){var c=ch[j];
        casBody+='<span style="font-size:10px;padding:2px 6px;border-radius:3px;background:rgba(255,255,255,.04)">';
        casBody+='<span style="color:'+COLORS[c.type]+'">'+LABELS[c.type]+'</span> ';
        casBody+=fmtDs(c.date)+' <span style="color:var(--dim)">'+c.oldSlots+'&rarr;'+c.newSlots+'</span>';
        casBody+='</span>';
      }
      if(ch.length>10)casBody+='<span style="font-size:9px;color:var(--dim);padding:2px 6px">+'+(ch.length-10)+' mas</span>';
      casBody+='</div>';
    }
    events.push({t:cl.createdAt,type:'cas_update',cat:'cas',label:'CAS',
      sum:sumText,body:casBody});
  }

  /* Sort descending */
  events.sort(function(a,b){return new Date(b.t).getTime()-new Date(a.t).getTime()});

  /* Apply filters */
  var filtered=[];
  for(var i=0;i<events.length;i++){
    if(evFilterState[events[i].cat])filtered.push(events[i]);
  }

  if(filtered.length===0){
    el.innerHTML='';emptyEl.style.display='';
    emptyEl.textContent=events.length>0?'sin eventos para estos filtros':'sin eventos recientes';
    return;
  }
  emptyEl.style.display='none';

  /* Group by day */
  var html='';var lastDay='';
  for(var i=0;i<Math.min(filtered.length,80);i++){var ev=filtered[i];
    var dayKey=evDateKey(ev.t);
    if(dayKey!==lastDay){
      html+='<div class="ev-day">'+evDateLabel(dayKey)+'</div>';
      lastDay=dayKey;
    }
    var isOpen=ev.open?true:false;
    html+='<div class="ev-item'+(isOpen?' open':'')+'" onclick="this.classList.toggle(\\'open\\')">';
    html+='<div class="ev-hdr">';
    html+='<span class="ev-time">'+fmtTime(ev.t)+'</span>';
    html+='<span class="ev-type ev-t-'+ev.type+'">'+ev.label+'</span>';
    html+='<span class="ev-sum">'+ev.sum+'</span>';
    if(ev.body)html+='<span class="ev-arrow">&#9656;</span>';
    html+='</div>';
    if(ev.body)html+='<div class="ev-body">'+ev.body+'</div>';
    html+='</div>';
  }
  el.innerHTML=html;
}

/* ── Calendar Tab ── */
function closenessColor(ds){
  if(!ds)return'var(--muted)';
  var p=ds.split('-').map(Number);
  var now=new Date();var bog=new Date(now.toLocaleString('en-US',TZ));
  var today=new Date(bog.getFullYear(),bog.getMonth(),bog.getDate());
  var d=Math.round((new Date(p[0],p[1]-1,p[2]).getTime()-today.getTime())/864e5);
  if(d<60)return'var(--green)';
  if(d<180)return'var(--amber)';
  return'var(--muted)';
}

function setCalMode(m){
  calMode=m;
  document.getElementById('calModeBest').className='ct-btn'+(m===0?' ct-on':'');
  document.getElementById('calModeAll').className='ct-btn'+(m===1?' ct-on':'');
  document.getElementById('calModeFlash').className='ct-btn'+(m===2?' ct-on':'');
  document.getElementById('calModeHistory').className='ct-btn'+(m===3?' ct-on':'');
  calIdx=0;calPollList=null;
  if(m!==3){var list=getCalPolls();if(list.length>0)autoScrollToEarliestDate(list[0]);}
  renderCalendar();
}

function getCalPolls(){
  if(calPollList)return calPollList;
  if(calMode===3)return[];

  /* calPolls: already filtered by hasDate=true (server-side). Fallback to lastPolls with manual filter. */
  var withDates;
  if(calPolls){
    withDates=calPolls;
  }else{
    if(!lastPolls)return[];
    withDates=[];
    for(var i=0;i<lastPolls.length;i++){
      var p=lastPolls[i];
      if((p.topDates&&p.topDates.length>0)||p.earliestDate)withDates.push(p);
    }
  }

  if(calMode===1){
    var weekAgo=Date.now()-7*864e5;
    calPollList=[];
    for(var i=0;i<withDates.length;i++){
      if(new Date(withDates[i].createdAt).getTime()>weekAgo)calPollList.push(withDates[i]);
    }
    return calPollList;
  }

  /* Mode "flash": synthetic polls from cancellations events (48h) */
  if(calMode===2){
    calPollList=[];
    if(tlData&&tlData.events){
      var byDate={};
      for(var i=0;i<tlData.events.length;i++){
        var ev=tlData.events[i];
        if(!byDate[ev.date])byDate[ev.date]={date:ev.date,count:0,firstSeen:ev.time,lastSeen:ev.time,totalDur:0};
        byDate[ev.date].count++;
        byDate[ev.date].totalDur+=ev.dur||0;
        if(ev.time<byDate[ev.date].firstSeen)byDate[ev.date].firstSeen=ev.time;
        if(ev.time>byDate[ev.date].lastSeen)byDate[ev.date].lastSeen=ev.time;
      }
      var sorted=[];for(var k in byDate)sorted.push(byDate[k]);
      sorted.sort(function(a,b){return a.date<b.date?-1:a.date>b.date?1:0});
      for(var i=0;i<sorted.length;i++){
        var fd=sorted[i];
        calPollList.push({
          _flash:true,
          topDates:[fd.date],
          allDates:[{date:fd.date}],
          earliestDate:fd.date,
          datesCount:1,rawDatesCount:fd.count,
          status:'flash',
          createdAt:new Date(fd.lastSeen).toISOString(),
          dateChanges:{appeared:[fd.date],disappeared:[]},
          _flashMeta:{count:fd.count,totalDur:fd.totalDur,firstSeen:fd.firstSeen,lastSeen:fd.lastSeen}
        });
      }
    }
    return calPollList;
  }

  /* Mode "mejores": dedup by earliestDate, sort by closeness */
  var now=new Date();var bog=new Date(now.toLocaleString('en-US',TZ));
  var todayMs=new Date(bog.getFullYear(),bog.getMonth(),bog.getDate()).getTime();
  function daysFrom(ds){
    if(!ds)return 99999;
    var q=ds.split('-').map(Number);
    return Math.round((new Date(q[0],q[1]-1,q[2]).getTime()-todayMs)/864e5);
  }

  function effDate(p){return p.earliestDate||(p.topDates&&p.topDates.length?p.topDates[0]:null)}
  var bestByDate={};
  for(var i=0;i<withDates.length;i++){
    var p=withDates[i];var ed=effDate(p);
    if(!ed)continue;
    if(!bestByDate[ed]||new Date(p.createdAt)>new Date(bestByDate[ed].createdAt)){
      bestByDate[ed]=p;
    }
  }

  var sorted=[];
  for(var k in bestByDate)sorted.push(bestByDate[k]);
  sorted.sort(function(a,b){return daysFrom(effDate(a))-daysFrom(effDate(b))});
  calPollList=sorted;
  return calPollList;
}

function autoScrollToEarliestDate(poll){
  var ed=poll?(poll.earliestDate||(poll.topDates&&poll.topDates.length?poll.topDates[0]:null)):null;
  if(!poll||!ed){calMonthOffset=0;return}
  var p=ed.split('-').map(Number);
  var now=new Date();var bog=new Date(now.toLocaleString('en-US',TZ));
  var curY=bog.getFullYear(),curM=bog.getMonth();
  var off=(p[0]-curY)*12+(p[1]-1-curM);
  var maxOff=calMaxMonthOffset(poll);
  calMonthOffset=Math.max(0,Math.min(maxOff,off));
}

var calDetailCache={};
async function loadPollDetail(poll){
  if(!poll||!poll.id)return poll;
  if(poll._full)return poll; /* already loaded */
  if(calDetailCache[poll.id])return calDetailCache[poll.id];
  try{
    var detail=await fetchJ(API+'/bots/'+BID+'/logs/polls/'+poll.id);
    detail._full=true;
    calDetailCache[poll.id]=detail;
    /* Merge back into list */
    for(var i=0;i<lastPolls.length;i++){
      if(lastPolls[i].id===poll.id){lastPolls[i]=detail;break}
    }
    if(calPolls){for(var i=0;i<calPolls.length;i++){if(calPolls[i].id===poll.id){calPolls[i]=detail;break}}}
    calPollList=null; /* reset cache */
    return detail;
  }catch(e){console.error('loadPollDetail err',e);return poll}
}

async function calNavPoll(dir){
  var list=getCalPolls();if(list.length===0)return;
  calIdx=Math.max(0,Math.min(list.length-1,calIdx+dir));
  var poll=list[calIdx];
  if(!poll._full&&poll.id){
    poll=await loadPollDetail(poll);
    list=getCalPolls(); /* refresh after merge */
    if(calIdx>=list.length)calIdx=list.length-1;
  }
  autoScrollToEarliestDate(list[calIdx]);
  renderCalendar();
}

function calNavMonth(dir){
  var list=getCalPolls();if(list.length===0)return;
  var poll=list[calIdx];
  var maxOff=calMaxMonthOffset(poll);
  calMonthOffset=Math.max(0,Math.min(maxOff,calMonthOffset+dir));
  renderCalendar();
}

function calMaxMonthOffset(poll){
  if(!poll)return 0;
  /* Use allDates if loaded (on-demand), else topDates */
  var last=null;
  if(poll.allDates&&poll.allDates.length>0){last=poll.allDates[poll.allDates.length-1].date}
  else if(poll.topDates&&poll.topDates.length>0){last=poll.topDates[poll.topDates.length-1]}
  if(!last)return 0;
  var lp=last.split('-').map(Number);
  var now=new Date();var bog=new Date(now.toLocaleString('en-US',TZ));
  var curY=bog.getFullYear(),curM=bog.getMonth();
  var diff=(lp[0]-curY)*12+(lp[1]-1-curM);
  return Math.max(0,diff);
}

function renderCalendar(){
  var list=getCalPolls();
  var infoEl=document.getElementById('calPollInfo');
  var metaEl=document.getElementById('calPollMeta');
  var gridEl=document.getElementById('calGrid');
  var legendEl=document.getElementById('calLegend');
  var chgEl=document.getElementById('calChanges');
  var prevBtn=document.getElementById('calPollPrev');
  var nextBtn=document.getElementById('calPollNext');
  var monPrev=document.getElementById('calMonPrev');
  var monNext=document.getElementById('calMonNext');
  var monInfo=document.getElementById('calMonInfo');

  /* Mode 3: Historia — tabla all-time una fila por día */
  if(calMode===3){
    infoEl.textContent='';monInfo.textContent='';
    prevBtn.classList.add('dis');nextBtn.classList.add('dis');
    monPrev.classList.add('dis');monNext.classList.add('dis');
    if(!dateHistory||dateHistory.length===0){
      metaEl.textContent='sin historial';
      gridEl.innerHTML='<div class="empty">sin datos históricos</div>';
      legendEl.innerHTML='';chgEl.innerHTML='';
      return;
    }
    metaEl.textContent=dateHistory.length+' días con datos';
    var curCon=lastBot?lastBot.currentConsularDate:null;
    var sorted=dateHistory.slice().reverse();
    var h='<div style="font-size:11px">';
    for(var i=0;i<sorted.length;i++){
      var dh=sorted[i];
      var isBetter=curCon&&dh.bestDate<curCon;
      var dateCol=isBetter?'var(--green)':'var(--muted)';
      h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid var(--border)">'
        +'<span style="color:var(--text);min-width:80px">'+fmtD(dh.day)+'</span>'
        +'<span style="color:'+dateCol+';flex:1;text-align:center">'+fmtD(dh.bestDate)+'</span>'
        +'<span style="color:var(--dim);font-size:9px">'+dh.polls+'p</span>'
        +'</div>';
    }
    h+='</div>';
    gridEl.innerHTML=h;
    legendEl.innerHTML='<span style="color:var(--green);font-size:9px">verde = mejor que cita actual</span>';
    chgEl.innerHTML='';
    return;
  }

  if(list.length===0){
    infoEl.textContent='0/0';
    metaEl.textContent='sin polls con fechas';
    gridEl.innerHTML='<div class="empty">sin datos de calendario</div>';
    legendEl.innerHTML='';chgEl.innerHTML='';
    return;
  }

  if(calIdx>=list.length)calIdx=0;
  var poll=list[calIdx];
  var maxOff=calMaxMonthOffset(poll);
  if(calMonthOffset>maxOff)calMonthOffset=maxOff;

  /* Poll nav */
  infoEl.textContent=(calIdx+1)+'/'+list.length;
  prevBtn.classList.toggle('dis',calIdx===0);
  nextBtn.classList.toggle('dis',calIdx===list.length-1);

  /* Poll meta — enriched */
  if(poll._flash){
    var fm=poll._flashMeta;
    var pBest=poll.earliestDate;
    var daysToBest=daysUntil(pBest);
    var dateColor=closenessColor(pBest);
    var avgDur=fm.count>0?Math.round(fm.totalDur/fm.count/1000):0;
    var lastT=fmtTime(new Date(fm.lastSeen).toISOString());
    metaEl.innerHTML='<b style="color:'+dateColor+'">'+fmtD(pBest)+'</b> <span style="font-size:9px;color:'+dateColor+'">'+daysToBest+'</span> &middot; '+fm.count+'x visto &middot; dur prom '+avgDur+'s &middot; ultimo: '+lastT+' &middot; <span style="color:var(--cyan);font-size:9px;font-weight:700">FLASH</span>';
  }else{
  var pTime=fmtTime(poll.createdAt);
  var pDates=poll.allDates?poll.allDates.length:(poll.rawDatesCount||poll.datesCount||0);
  var pFiltered=poll.datesCount||0;
  var pBest=poll.earliestDate||(poll.allDates&&poll.allDates.length>0?poll.allDates[0].date:(poll.topDates&&poll.topDates.length>0?poll.topDates[0]:null));
  var daysToBest=daysUntil(pBest);
  var dateColor=closenessColor(pBest);
  var chgInline='';
  var dc=poll.dateChanges;
  if(dc){
    var app=dc.appeared||[],dis=dc.disappeared||[];
    if(app.length>0)chgInline+=' <span style="color:var(--green)">+'+app.length+'</span>';
    if(dis.length>0)chgInline+=' <span style="color:var(--red)">-'+dis.length+'</span>';
  }
  var datesLabel=pFiltered!==pDates&&pDates>0?pFiltered+'/'+pDates+' fechas':(pFiltered||pDates)+' fechas';
  var bestLabel=poll.earliestDate?fmtD(pBest):(pBest?fmtD(pBest)+' <span style="font-size:9px;color:var(--muted)">(raw)</span>':'--');
  metaEl.innerHTML='<b>'+pTime+'</b> &middot; '+datesLabel+' &middot; mejor: <b style="color:'+dateColor+'">'+bestLabel+'</b> <span style="font-size:9px;color:'+dateColor+'">'+daysToBest+'</span>'+chgInline+' &middot; '+badge(poll.status);
  }

  /* Build lookup sets — use allDates if available (loaded on-demand), fallback to topDates */
  var availSet={};
  if(poll.allDates&&poll.allDates.length>0){
    for(var i=0;i<poll.allDates.length;i++){
      availSet[poll.allDates[i].date]=true;
    }
  }else if(poll.topDates){
    for(var i=0;i<poll.topDates.length;i++){
      availSet[poll.topDates[i]]=true;
    }
  }
  var appearedSet={},disappearedSet={};
  if(poll.dateChanges){
    if(poll.dateChanges.appeared)for(var i=0;i<poll.dateChanges.appeared.length;i++)appearedSet[poll.dateChanges.appeared[i]]=true;
    if(poll.dateChanges.disappeared)for(var i=0;i<poll.dateChanges.disappeared.length;i++)disappearedSet[poll.dateChanges.disappeared[i]]=true;
  }

  /* Exclusion check */
  function isExcluded(ds){
    if(!lastExclusions)return false;
    for(var i=0;i<lastExclusions.length;i++){
      var ex=lastExclusions[i];
      if(ds>=ex.startDate&&ds<=ex.endDate)return true;
    }
    return false;
  }

  /* Current appointment + today */
  var curCon=lastBot?lastBot.currentConsularDate:null;
  var curCas=lastBot?lastBot.currentCasDate:null;
  var now=new Date();var bog=new Date(now.toLocaleString('en-US',TZ));
  var todayStr=bog.getFullYear()+'-'+String(bog.getMonth()+1).padStart(2,'0')+'-'+String(bog.getDate()).padStart(2,'0');

  /* Month navigation */
  var baseY=bog.getFullYear(),baseM=bog.getMonth();
  var m1=baseM+calMonthOffset;
  var y1=baseY+Math.floor(m1/12);m1=((m1%12)+12)%12;
  var m2=baseM+calMonthOffset+1;
  var y2=baseY+Math.floor(m2/12);m2=((m2%12)+12)%12;

  var MNAMES=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  var monLabel=MNAMES[m1]+(y1===y2&&m1!==m2?' - '+MNAMES[m2]:' '+y1+(m1!==m2?' - '+MNAMES[m2]:' '))+' '+y2;
  monInfo.textContent=monLabel;
  monPrev.classList.toggle('dis',calMonthOffset===0);
  monNext.classList.toggle('dis',calMonthOffset>=maxOff);

  /* Render 2 months */
  var html='<div class="cal-months">';
  var months=[[y1,m1],[y2,m2]];
  var DOW_HDR=['lu','ma','mi','ju','vi','sa','do'];

  for(var mi=0;mi<months.length;mi++){
    var yr=months[mi][0],mo=months[mi][1];
    html+='<div class="cal-month">';
    html+='<div class="cal-month-title">'+MNAMES[mo]+' '+yr+'</div>';
    html+='<div class="cal-grid">';
    for(var h=0;h<7;h++)html+='<div class="cal-hdr">'+DOW_HDR[h]+'</div>';

    var first=new Date(yr,mo,1);
    var startDow=(first.getDay()+6)%7;
    var daysInMonth=new Date(yr,mo+1,0).getDate();

    /* Padding cells for previous month */
    var prevMonth=new Date(yr,mo,0).getDate();
    for(var d=startDow-1;d>=0;d--){
      var pd=prevMonth-d;
      html+='<div class="cal-cell other">'+pd+'</div>';
    }

    for(var d=1;d<=daysInMonth;d++){
      var ds=yr+'-'+String(mo+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      var dt=new Date(yr,mo,d);
      var wd=dt.getDay();
      var cls='cal-cell';
      if(wd===0||wd===6)cls+=' wknd';
      if(ds===todayStr)cls+=' today';
      if(isExcluded(ds))cls+=' excl';
      if(availSet[ds])cls+=' avail';
      if(ds===curCon||ds===curCas)cls+=' appt';
      if(appearedSet[ds])cls+=' appeared';
      if(disappearedSet[ds])cls+=' disappeared';
      html+='<div class="'+cls+'">'+d+'</div>';
    }

    /* Padding cells for next month */
    var totalCells=startDow+daysInMonth;
    var rem=totalCells%7;
    if(rem>0)for(var d=1;d<=7-rem;d++)html+='<div class="cal-cell other">'+d+'</div>';

    html+='</div></div>';
  }
  html+='</div>';
  gridEl.innerHTML=html;

  /* Legend */
  legendEl.innerHTML=
    '<span class="cal-leg"><span class="cal-sw" style="background:rgba(74,222,128,.15)"></span>disponible</span>'+
    '<span class="cal-leg"><span class="cal-sw" style="background:repeating-linear-gradient(135deg,transparent,transparent 3px,rgba(248,113,113,.12) 3px,rgba(248,113,113,.12) 5px)"></span>excluida</span>'+
    '<span class="cal-leg"><span class="cal-sw" style="background:rgba(74,222,128,.08);background-image:repeating-linear-gradient(135deg,transparent,transparent 3px,rgba(248,113,113,.12) 3px,rgba(248,113,113,.12) 5px)"></span>excl+disp</span>'+
    '<span class="cal-leg"><span class="cal-sw" style="background:var(--surface);box-shadow:inset 0 0 0 1.5px var(--accent)"></span>hoy</span>'+
    '<span class="cal-leg"><span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--accent);margin-right:2px"></span>cita</span>'+
    '<span class="cal-leg"><span style="display:inline-block;width:4px;height:4px;border-radius:50%;background:var(--cyan);margin-right:2px"></span>nueva</span>'+
    '<span class="cal-leg"><span style="text-decoration:line-through;color:var(--red);font-size:9px;margin-right:2px">X</span>desapar.</span>';

  /* Changes */
  var appDates=poll.dateChanges?poll.dateChanges.appeared||[]:[];
  var disDates=poll.dateChanges?poll.dateChanges.disappeared||[]:[];
  if(appDates.length===0&&disDates.length===0){
    chgEl.innerHTML='<div class="empty">sin cambios en este poll</div>';
  }else{
    var ch='';
    for(var i=0;i<appDates.length;i++){
      ch+='<div class="cal-ch-item"><span class="cal-ch-date cal-ch-app">+'+fmtDs(appDates[i])+'</span><span>'+dow(appDates[i])+'</span><span style="color:var(--green)">aparecio</span></div>';
    }
    for(var i=0;i<disDates.length;i++){
      ch+='<div class="cal-ch-item"><span class="cal-ch-date cal-ch-dis">'+fmtDs(disDates[i])+'</span><span>'+dow(disDates[i])+'</span><span style="color:var(--red)">desaparecio</span></div>';
    }
    chgEl.innerHTML=ch;
  }
}

/* ── Cancelaciones scatter ── */
/* tlData is set from server response (cancellations endpoint) during refresh */
function buildCancelData(){
  return tlData;
}

function handleTlClick(evt){
  var canvas=document.getElementById('tlCanvas');
  if(!canvas||tlDots.length===0)return;
  var rect=canvas.getBoundingClientRect();
  var mx=evt.clientX-rect.left,my=evt.clientY-rect.top;
  /* Find nearest dot within 25px */
  var best=null,bestDist=625; /* 25^2 */
  for(var i=0;i<tlDots.length;i++){
    var d=tlDots[i];
    var dx=d.px-mx,dy=d.py-my;
    var dist=dx*dx+dy*dy;
    if(dist<bestDist){bestDist=dist;best=d}
  }
  if(best){
    tlSelDate=(tlSelDate===best.date)?null:best.date;
  }else{
    tlSelDate=null;
  }
  renderTimelines();
}

function fmtDur(ms){
  if(ms===null)return'?';
  var s=Math.round(ms/1000);
  if(s<60)return s+'s';
  var m=Math.round(s/60);
  if(m<60)return m+'min';
  var h=Math.floor(m/60);
  return h+'h '+((m%60)>0?(m%60)+'m':'');
}

function renderTimelines(){
  var canvas=document.getElementById('tlCanvas');
  var emptyEl=document.getElementById('tlEmpty');
  var sumEl=document.getElementById('tlSum');
  var legEl=document.getElementById('tlLeg');
  var detEl=document.getElementById('tlDetail');
  if(!canvas)return;

  var rawData=buildCancelData();
  var data=rawData;
  if(data&&data.events&&lastBot&&lastBot.targetDateBefore){
    var tdb=lastBot.targetDateBefore;
    var tdbMs=new Date(tdb).getTime();
    var cutoff=new Date(tdbMs-30*86400000).toISOString().slice(0,10);
    var filteredEvts=data.events.filter(function(e){return e.date>=cutoff&&e.date<tdb;});
    var filteredOut=data.events.length-filteredEvts.length;
    data=Object.assign({},data,{events:filteredEvts,totalEvents:filteredEvts.length,uniqueDates:new Set(filteredEvts.map(function(e){return e.date;})).size,closeCount:filteredEvts.filter(function(e){return e.days<60;}).length});
    if(filteredOut>0)data._filteredNote='('+filteredOut+' fechas fuera de ventana)';
  }
  if(!data||!data.events||data.events.length===0){
    canvas.style.display='none';emptyEl.style.display='';
    sumEl.innerHTML='';legEl.innerHTML='';if(detEl)detEl.style.display='none';
    return;
  }
  canvas.style.display='';emptyEl.style.display='none';

  /* Bind click handler once */
  if(!tlClickBound){
    canvas.addEventListener('click',handleTlClick);
    tlClickBound=true;
  }

  var ctx=canvas.getContext('2d');
  var dpr=window.devicePixelRatio||1;
  var rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;
  ctx.scale(dpr,dpr);
  var W=rect.width,H=rect.height;

  var events=data.events;
  var tMin=data.tMin,tMax=data.tMax;

  /* Y range = days from today (closer = top) */
  var yVals=[];
  for(var i=0;i<events.length;i++)yVals.push(events[i].days);
  var curDays=lastBot&&lastBot.currentConsularDate?daysUntilNum(lastBot.currentConsularDate):null;
  if(curDays!==null)yVals.push(curDays);
  var yMin=Math.min.apply(null,yVals)-5;
  var yMax=Math.max.apply(null,yVals)+5;
  if(yMin<0)yMin=0;

  var pad={t:8,r:20,b:28,l:32};
  var cW=W-pad.l-pad.r,cH=H-pad.t-pad.b;
  function sx(v){return pad.l+(v-tMin)/(tMax-tMin)*cW}
  function sy(v){return pad.t+(v-yMin)/(yMax-yMin)*cH}

  ctx.clearRect(0,0,W,H);

  /* Grid */
  ctx.strokeStyle='rgba(255,255,255,0.03)';ctx.lineWidth=1;
  for(var i=0;i<=4;i++){var yy=pad.t+cH*i/4;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(W-pad.r,yy);ctx.stroke()}

  /* Reference line — current appointment */
  if(curDays!==null){
    var refY=sy(curDays);
    ctx.strokeStyle='rgba(248,113,113,0.25)';ctx.setLineDash([3,3]);ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(pad.l,refY);ctx.lineTo(W-pad.r,refY);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='rgba(248,113,113,0.4)';ctx.font='8px monospace';ctx.textAlign='right';
    ctx.fillText('cita',W-pad.r,refY-3);
  }

  /* Store dot positions for hit testing */
  tlDots=[];

  /* Dots — two passes: dimmed first, then highlighted */
  var hasSel=tlSelDate!==null;
  for(var pass=0;pass<2;pass++){
    for(var i=0;i<events.length;i++){
      var e=events[i];
      var isSel=e.date===tlSelDate;
      /* pass 0: non-selected (or all if no selection). pass 1: selected only */
      if(hasSel&&pass===0&&isSel)continue;
      if(hasSel&&pass===1&&!isSel)continue;
      if(!hasSel&&pass===1)continue;

      var px=sx(e.time),py=sy(e.days);
      var color,glow,r;
      if(e.days<60){color='rgba(74,222,128,0.85)';glow='rgba(74,222,128,0.25)';r=4}
      else if(e.days<180){color='rgba(252,211,77,0.6)';glow='rgba(252,211,77,0.15)';r=3}
      else{color='rgba(90,90,101,0.5)';glow=null;r=2}

      if(hasSel&&!isSel){
        /* Dim non-selected */
        color='rgba(58,58,66,0.25)';glow=null;r=2;
      }else if(hasSel&&isSel){
        /* Boost selected */
        if(e.days<60){color='rgba(74,222,128,1)';glow='rgba(74,222,128,0.4)';r=5}
        else if(e.days<180){color='rgba(252,211,77,0.9)';glow='rgba(252,211,77,0.3)';r=4.5}
        else{color='rgba(160,160,171,0.7)';glow='rgba(160,160,171,0.2)';r=3.5}
      }

      if(glow){ctx.fillStyle=glow;ctx.beginPath();ctx.arc(px,py,r+3,0,Math.PI*2);ctx.fill()}
      ctx.fillStyle=color;ctx.beginPath();ctx.arc(px,py,r,0,Math.PI*2);ctx.fill();

      /* Selection ring */
      if(hasSel&&isSel){
        ctx.strokeStyle=color;ctx.lineWidth=1;
        ctx.beginPath();ctx.arc(px,py,r+5,0,Math.PI*2);ctx.stroke();
      }

      /* Connect appeared→disappeared with line */
      if(hasSel&&isSel&&e.goneAt){
        var gpx=sx(e.goneAt);
        ctx.strokeStyle='rgba(248,113,113,0.3)';ctx.lineWidth=1;ctx.setLineDash([2,2]);
        ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(gpx,py);ctx.stroke();ctx.setLineDash([]);
        /* Small x at disappearance */
        ctx.strokeStyle='rgba(248,113,113,0.5)';ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(gpx-2,py-2);ctx.lineTo(gpx+2,py+2);ctx.stroke();
        ctx.beginPath();ctx.moveTo(gpx-2,py+2);ctx.lineTo(gpx+2,py-2);ctx.stroke();
      }

      if(pass===0||isSel)tlDots.push({px:px,py:py,date:e.date,idx:i});
    }
  }

  /* Y labels (days) */
  ctx.fillStyle='rgba(255,255,255,0.15)';ctx.font='8px monospace';ctx.textAlign='right';
  for(var i=0;i<=4;i++){
    var v=Math.round(yMin+(yMax-yMin)*i/4);
    ctx.fillText(v+'d',pad.l-3,pad.t+cH*i/4+3);
  }

  /* X labels (time) */
  ctx.fillStyle='rgba(255,255,255,0.15)';ctx.font='8px monospace';ctx.textAlign='center';
  for(var i=0;i<5;i++){
    var xv=tMin+(tMax-tMin)*i/4;
    var xd=new Date(xv);
    var xs=xd.toLocaleString('en-US',Object.assign({},TZ,{hour:'2-digit',minute:'2-digit',hour12:false}));
    ctx.fillText(xs,pad.l+cW*i/4,H-pad.b+12);
  }

  /* Summary */
  var spanH=Math.round((tMax-tMin)/36e5*10)/10;
  var burstStr='';
  for(var i=0;i<data.bursts.length;i++){
    var b=data.bursts[i];
    var bt=new Date(b.time);
    var bs=bt.toLocaleString('en-US',Object.assign({},TZ,{hour:'2-digit',minute:'2-digit',hour12:false}));
    burstStr+=(i>0?', ':'')+bs+' ('+b.count+')';
  }
  sumEl.innerHTML=
    '<span style="color:var(--bright)">'+data.totalEvents+' apariciones</span>'+
    '<span style="color:var(--muted)">'+data.uniqueDates+' unicas</span>'+
    (data.closeCount>0?'<span style="color:var(--green)">'+data.closeCount+' cercanas</span>':'')+
    '<span style="color:var(--dim)">'+spanH+'h</span>'+
    (burstStr?'<br><span style="color:var(--cyan);font-size:9px">bursts: '+burstStr+'</span>':'')+
    (data._filteredNote?'<br><span style="color:var(--dim);font-size:9px">'+data._filteredNote+'</span>':'');

  /* Legend */
  legEl.innerHTML=
    '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:rgba(74,222,128,.85);vertical-align:middle;margin-right:3px"></span>&lt;60d</span>'+
    '<span><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:rgba(252,211,77,.6);vertical-align:middle;margin-right:3px"></span>60-180d</span>'+
    '<span><span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:rgba(90,90,101,.5);vertical-align:middle;margin-right:3px"></span>&gt;180d</span>'+
    '<span><span style="display:inline-block;width:16px;border-top:1px dashed rgba(248,113,113,.4);vertical-align:middle;margin-right:3px"></span>cita actual</span>';

  /* Detail panel for selected date */
  if(!detEl)return;
  if(!tlSelDate){detEl.style.display='none';return}

  /* Collect events for selected date */
  var selEvts=[];
  for(var i=0;i<events.length;i++){
    if(events[i].date===tlSelDate)selEvts.push(events[i]);
  }
  if(selEvts.length===0){detEl.style.display='none';return}

  detEl.style.display='block';
  var d0=selEvts[0];
  var dColor=closenessColor(tlSelDate);
  var daysTxt=daysUntilNum(tlSelDate);
  var catTxt=daysTxt<60?'cercana':daysTxt<180?'media':'lejana';
  var catColor=dColor;

  /* Header row */
  var html='<div class="tl-detail-row">';
  html+='<span class="tl-detail-date" style="color:'+dColor+'">'+fmtD(tlSelDate)+'</span>';
  html+='<span><span class="tl-detail-tag" style="background:'+dColor+';color:var(--bg)">'+daysTxt+'d &middot; '+catTxt+'</span></span>';
  html+='</div>';

  /* Appearance/disappearance pairs */
  html+='<div class="pairs">';
  var totalVis=0;
  for(var i=0;i<selEvts.length;i++){
    var ev=selEvts[i];
    var appTime=new Date(ev.time).toLocaleString('en-US',Object.assign({},TZ,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}));
    var goneTxt=ev.goneAt?new Date(ev.goneAt).toLocaleString('en-US',Object.assign({},TZ,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})):'aun visible';
    var durTxt=fmtDur(ev.dur);
    if(ev.dur!==null)totalVis+=ev.dur;
    var durColor=ev.dur===null?'var(--green)':ev.dur<600000?'var(--red)':ev.dur<3600000?'var(--amber)':'var(--green)';
    html+='<div class="pair">';
    html+='<span style="color:var(--green)">+'+appTime+'</span>';
    html+='<span style="color:var(--muted)">&rarr;</span>';
    html+='<span style="color:'+(ev.goneAt?'var(--red)':'var(--green)')+'">'+goneTxt+'</span>';
    html+='<span style="color:'+durColor+'">'+durTxt+'</span>';
    html+='</div>';
  }
  html+='</div>';

  /* Summary line */
  html+='<div class="tl-detail-row" style="margin-top:4px;color:var(--muted);font-size:9px">';
  html+='<span>'+selEvts.length+'x apariciones</span>';
  if(totalVis>0)html+='<span>visible total: '+fmtDur(totalVis)+'</span>';
  html+='</div>';

  detEl.innerHTML=html;
}

tickClock();refresh();
setInterval(tickClock,1000);
setInterval(tickCd,1000);
setInterval(refresh,60000);
document.querySelector('.hdr').addEventListener('click',function(){refresh()});
window.addEventListener('resize',function(){
  if(lastPolls&&lastBot)drawChart(lastPolls,lastBot.currentConsularDate,lastSummary,chartMode);
  renderTimelines();
});

/* ── Phone edit ── */
function editPhone(){
  document.getElementById('infoPhoneDisplay').style.display='none';
  document.getElementById('infoPhoneAdd').style.display='none';
  document.getElementById('infoPhoneEdit').style.display='flex';
  var inp=document.getElementById('phoneInput');
  inp.value=lastBot&&lastBot.notificationPhone?lastBot.notificationPhone:'';
  inp.focus();
}
function cancelPhoneEdit(){
  document.getElementById('infoPhoneEdit').style.display='none';
  if(lastBot&&lastBot.notificationPhone){
    document.getElementById('infoPhoneDisplay').style.display='';
  }else{
    document.getElementById('infoPhoneAdd').style.display='';
  }
}
function savePhone(){
  var v=document.getElementById('phoneInput').value.trim().replace(/[^0-9]/g,'');
  if(!/^\\d{10,15}$/.test(v)){alert('10-15 digitos');return;}
  fetch(API+'/bots/'+BID,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({notificationPhone:v})})
    .then(function(r){if(!r.ok)throw new Error(r.status);return r.json()})
    .then(function(){refresh()})
    .catch(function(e){alert('Error: '+e.message)});
}

/* ── Cobros ── */
var WA_SVG='<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>';

function getCobroCfg(){
  return {
    currency:localStorage.getItem('cobro_currency')||'COP',
    base:parseInt(localStorage.getItem('cobro_base')||'700'),
    extra:parseInt(localStorage.getItem('cobro_extra')||'400')
  };
}

function cobroDays(oldD,newD){
  return Math.round((new Date(oldD).getTime()-new Date(newD).getTime())/864e5);
}

function fmtMoney(n){return n.toLocaleString('es-CO')}

function renderCobros(){
  var el=document.getElementById('cobrosContent');
  if(!lastRss||!lastBot){el.innerHTML='<div class="cobro-empty">cargando...</div>';return;}

  var okRss=lastRss.filter(function(r){return r.success&&r.oldConsularDate&&r.newConsularDate});
  if(!okRss.length){el.innerHTML='<div class="cobro-empty">sin reagendamientos exitosos</div>';return;}

  okRss.sort(function(a,b){return new Date(a.createdAt)-new Date(b.createdAt)});
  var cfg=getCobroCfg();
  var nPersonas=(lastBot.applicantIds||[]).length||1;
  var tariff=cfg.base+(cfg.extra*(nPersonas-1));

  var html='';

  /* Config */
  html+='<div class="cobro-cfg">';
  html+='<label>moneda <select id="cobroCurrency" onchange="saveCoboCfg()"><option'+(cfg.currency==='COP'?' selected':'')+'>COP</option><option'+(cfg.currency==='USD'?' selected':'')+'>USD</option></select></label>';
  html+='<label>base/d\\u00eda <input id="cobroBase" type="number" value="'+cfg.base+'" onchange="saveCoboCfg()"></label>';
  html+='<label>extra/pers <input id="cobroExtra" type="number" value="'+cfg.extra+'" onchange="saveCoboCfg()"></label>';
  html+='<span style="font-size:9px;color:var(--dim)">'+nPersonas+'p \\u00d7 $'+fmtMoney(tariff)+'/d</span>';
  html+='</div>';

  /* Reschedule list */
  html+='<div class="cobro-list">';
  okRss.forEach(function(r,i){
    var days=cobroDays(r.oldConsularDate,r.newConsularDate);
    var sub=days*tariff;
    html+='<label class="cobro-item" id="ci'+i+'">';
    html+='<input type="checkbox" class="cobro-cb" data-idx="'+i+'" onchange="updateCobros()">';
    html+='<span class="cobro-dates"><span class="cobro-old">'+fmtDs(r.oldConsularDate)+'</span>';
    html+='<span class="cobro-arrow"> \\u2192 </span>';
    html+='<span class="cobro-new">'+fmtDs(r.newConsularDate)+'</span></span>';
    html+='<span class="cobro-days">-'+days+'d</span>';
    html+='<span class="cobro-sub">$'+fmtMoney(sub)+'</span>';
    html+='</label>';
  });
  html+='</div>';

  /* Total */
  html+='<div class="cobro-total-row">';
  html+='<span class="cobro-total-lbl">total seleccionado</span>';
  html+='<span class="cobro-total-val" id="cobroTotal">$0</span>';
  html+='</div>';
  html+='<div class="cobro-detail" id="cobroDetail"></div>';

  /* WA button + preview */
  if(lastBot.notificationPhone){
    html+='<div class="cobro-actions">';
    html+='<button class="cobro-wa-btn" onclick="openCobroWa()" id="cobroWaBtn" disabled>'+WA_SVG+' Enviar</button>';
    html+='<div class="cobro-preview-wrap"><textarea class="cobro-preview" id="cobroPreview" readonly placeholder="selecciona reagendamientos..."></textarea>';
    html+='<span class="cobro-copy" onclick="copyCobroMsg()">copiar</span></div>';
    html+='</div>';
  }else{
    html+='<div class="cobro-no-phone">\\u26a0 sin whatsapp configurado \\u2014 agr\\u00e9galo en info cuenta</div>';
  }

  el.innerHTML=html;
  window._cobroRss=okRss;
}

function saveCoboCfg(){
  localStorage.setItem('cobro_currency',document.getElementById('cobroCurrency').value);
  localStorage.setItem('cobro_base',document.getElementById('cobroBase').value);
  localStorage.setItem('cobro_extra',document.getElementById('cobroExtra').value);
  renderCobros();
}

function updateCobros(){
  if(!window._cobroRss)return;
  var cfg=getCobroCfg();
  var nPersonas=(lastBot.applicantIds||[]).length||1;
  var tariff=cfg.base+(cfg.extra*(nPersonas-1));
  var checks=document.querySelectorAll('.cobro-cb');
  var totalDays=0,totalMoney=0,selected=[];
  checks.forEach(function(cb){
    var idx=parseInt(cb.dataset.idx);
    var r=window._cobroRss[idx];
    var item=document.getElementById('ci'+idx);
    if(cb.checked){
      item.classList.add('checked');
      var d=cobroDays(r.oldConsularDate,r.newConsularDate);
      totalDays+=d;totalMoney+=d*tariff;
      selected.push(r);
    }else{
      item.classList.remove('checked');
    }
  });
  document.getElementById('cobroTotal').textContent='$'+fmtMoney(totalMoney);
  var det=document.getElementById('cobroDetail');
  if(selected.length>0){
    det.textContent=nPersonas+' persona'+(nPersonas>1?'s':'')+' \\u00d7 $'+fmtMoney(tariff)+'/d \\u00d7 '+totalDays+'d = $'+fmtMoney(totalMoney)+' '+cfg.currency;
  }else{det.textContent='';}

  var preview=document.getElementById('cobroPreview');
  var waBtn=document.getElementById('cobroWaBtn');
  if(preview&&selected.length>0){
    preview.value=generateCobroMsg(lastBot,selected,tariff,cfg.currency,nPersonas,totalDays,totalMoney);
    if(waBtn)waBtn.disabled=false;
  }else if(preview){
    preview.value='';
    if(waBtn)waBtn.disabled=true;
  }
}

function generateCobroMsg(bot,selected,tariff,currency,nPersonas,totalDays,totalMoney){
  var ownerName='';
  if(bot.ownerEmail){var p=bot.ownerEmail.split('@')[0];ownerName=p.charAt(0).toUpperCase()+p.slice(1);}
  var oldest=selected[0].oldConsularDate;
  var newest=selected[selected.length-1].newConsularDate;
  var msg='Hola '+ownerName+' \\ud83d\\udc4b\\n\\n';
  msg+='Tu cita de visa se adelant\\u00f3:\\n\\n';
  msg+='\\ud83d\\udcc5 '+fmtDs(oldest)+' \\u2192 '+fmtDs(newest)+'\\n';
  msg+='\\ud83d\\udcc6 '+totalDays+' d\\u00edas adelantados\\n';
  msg+='\\ud83d\\udcb0 '+nPersonas+' persona'+(nPersonas>1?'s':'')+' \\u00d7 $'+fmtMoney(tariff)+'/d\\u00eda \\u00d7 '+totalDays+'d = $'+fmtMoney(totalMoney)+'\\n\\n';
  msg+='Total: *$'+fmtMoney(totalMoney)+' '+currency+'*\\n\\n';
  msg+='Seguimos buscando mejores fechas.';
  return msg;
}

function openCobroWa(){
  if(!lastBot||!lastBot.notificationPhone)return;
  var msg=document.getElementById('cobroPreview').value;
  if(!msg)return;
  window.open('https://wa.me/'+lastBot.notificationPhone+'?text='+encodeURIComponent(msg),'_blank');
}

function copyCobroMsg(){
  var ta=document.getElementById('cobroPreview');
  if(!ta||!ta.value)return;
  navigator.clipboard.writeText(ta.value).then(function(){
    var btn=document.querySelector('.cobro-copy');
    if(btn){btn.textContent='\\u2713 copiado';setTimeout(function(){btn.textContent='copiar'},1500);}
  });
}
</script>
</body>
</html>`;
}
