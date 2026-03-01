import { Hono } from 'hono';

export const dashboardRouter = new Hono();

dashboardRouter.get('/', (c) => c.html(renderLanding()));

dashboardRouter.get('/:botId', async (c) => {
  const raw = c.req.param('botId');
  const botId = parseInt(raw, 10);
  if (isNaN(botId)) return c.text('Invalid bot ID', 400);
  const webshareIps = await fetchAllWebshareIps();
  return c.html(renderDashboard(String(botId), webshareIps));
});

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

function limitBar(count,max){
  if(max==null)return '';
  var pct=Math.min(100,Math.round(count/max*100));
  var color=pct>=100?'var(--red)':pct>=50?'var(--amber)':'var(--green)';
  return '<span class="limits">'+count+'/'+max+' <span class="bar"><span class="fill" style="width:'+pct+'%;background:'+color+'"></span></span></span>';
}

async function load(){
  try{
    var bots=await (await fetch('/api/bots')).json();
    if(!Array.isArray(bots)||bots.length===0){
      document.getElementById('content').innerHTML='<div class="empty-msg">no hay bots configurados</div>';
      document.getElementById('summary').innerHTML='';
      return;
    }

    // Group by country
    var groups={};
    bots.forEach(function(b){
      var code=cc(b.locale);
      if(!groups[code])groups[code]={bots:[],meta:meta(code)};
      groups[code].bots.push(b);
    });

    // Summary
    var active=bots.filter(function(b){return b.status==='active'}).length;
    var countries=Object.keys(groups).length;
    document.getElementById('summary').innerHTML=
      '<div class="stat"><div class="stat-val">'+bots.length+'</div><div class="stat-lbl">bots</div></div>'+
      '<div class="stat"><div class="stat-val">'+active+'</div><div class="stat-lbl">activos</div></div>'+
      '<div class="stat"><div class="stat-val">'+countries+'</div><div class="stat-lbl">paises</div></div>';

    // Sort groups: countries with more bots first, then alphabetical
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
        var roles=[];
        if(b.isScout)roles.push('scout');
        if(b.isSubscriber)roles.push('subscriber');
        metaParts.push(roles.join('+')||'none');
        if(b.consecutiveErrors>0)metaParts.push('<span style="color:var(--red)">'+b.consecutiveErrors+' err</span>');
        if(b.targetDateBefore)metaParts.push('target &lt; '+fmtD(b.targetDateBefore));
        var limitsHtml=limitBar(b.rescheduleCount,b.maxReschedules);
        if(limitsHtml)metaParts.push(limitsHtml);

        html+='<a class="bot-card" href="/dashboard/'+b.id+'">';
        html+='<span class="bot-id">#'+b.id+'</span>';
        html+='<span class="bot-info">';
        html+='<div class="bot-appt">'+(apptStr||'<span class="bot-appt-none">sin cita</span>')+'</div>';
        html+='<div class="bot-meta">'+metaParts.join(' <span style="color:var(--dim)">&middot;</span> ')+'</div>';
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
  }catch(e){
    console.error('fetch error',e);
    document.getElementById('content').innerHTML='<div class="empty-msg">error cargando bots</div>';
  }
}

tickClock();load();
setInterval(tickClock,1000);
setInterval(load,30000);
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

/* ── Subscriber view ── */
.sub-kv{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)}
.sub-kv:last-child{border-bottom:none}
.sub-k{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.5px}
.sub-v{font-weight:700;font-size:11px}
.sub-scout-status{display:flex;align-items:center;gap:8px;padding:6px 0}
.sub-scout-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.sub-disp-item{padding:6px 0;border-bottom:1px solid var(--border);font-size:11px}
.sub-disp-item:last-child{border-bottom:none}
.sub-disp-dates{font-size:10px;color:var(--muted);margin-top:2px}
.sub-disp-timing{font-size:9px;color:var(--dim);margin-top:1px}
.sub-limits{display:flex;align-items:center;gap:6px}
.sub-limits-bar{flex:1;max-width:80px;height:6px;background:var(--dim);border-radius:3px;overflow:hidden}
.sub-limits-fill{height:100%;border-radius:3px}

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
  <span id="lastRsRow" style="display:none"><span class="sep">&middot;</span><span class="strip-lbl">resch</span><span id="lastRsVal" class="strip-val" style="font-size:10px">--</span></span>
  <div id="actions" class="actions" style="display:none;width:100%;margin-top:4px"></div>
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
    <div id="targetRow" class="appt-row" style="display:none;margin-top:4px;border-top:1px solid var(--border);padding-top:6px">
      <span class="appt-lbl" style="color:var(--muted)">objetivo</span>
      <span><span id="targetVal" class="appt-val" style="font-size:12px"></span><span id="targetWindow" class="appt-days"></span></span>
    </div>
    <div id="rsLimitRow" class="appt-row" style="display:none">
      <span class="appt-lbl" style="color:var(--muted)">intentos</span>
      <span id="rsLimitVal" style="font-size:11px;font-weight:700"></span>
    </div>
    <div id="exclRow" style="display:none;margin-top:5px;padding-top:5px;border-top:1px solid var(--border);font-size:9px;line-height:1.8"></div>
  </div>
</div>

<!-- Tabs (hidden for subscribers) -->
<div class="tabs" id="scoutTabs">
  <div class="tab on" onclick="switchTab(0)">monitor</div>
  <div id="casTabBtn" class="tab" onclick="switchTab(1)">cas map</div>
  <div class="tab" onclick="switchTab(2)">eventos</div>
  <div class="tab" onclick="switchTab(3)">calendario</div>
</div>

<!-- ═══ SUBSCRIBER VIEW (hidden for scouts) ═══ -->
<div id="subscriberView" style="display:none">

<div class="card">
  <div class="card-t">configuracion</div>
  <div id="subConfig" style="font-size:11px;line-height:2"></div>
</div>

<div class="card">
  <div class="card-t">scout</div>
  <div id="subScout" style="font-size:11px"></div>
</div>

<div class="card">
  <div class="card-t">dispatches recibidos</div>
  <div id="subDispatches"></div>
  <div id="subDispEmpty" class="empty">sin dispatches</div>
</div>

<div class="card">
  <div class="card-t">reagendamientos</div>
  <div id="subReschedules"></div>
  <div id="subRsEmpty" class="empty">sin reschedules</div>
</div>

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

<div class="foot">tap header to refresh &middot; auto 30s</div>

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
var cd=30,timer,lastBot=null,lastPolls=null,lastSummary=null,chartMode=0;
var calIdx=0,calMonthOffset=0,lastExclusions=null,calPollList=null,calMode=0;
var tlData=null,tlSelDate=null,tlDots=[],tlClickBound=false;

function switchTab(n){
  var tabs=document.querySelectorAll('.tab');
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
  document.getElementById('cdFill').style.width=Math.max(0,cd/30*100)+'%';
  document.getElementById('cdTime').textContent=cd+'s';
  if(cd<=0)refresh();
}

async function fetchJ(u){var r=await fetch(u);if(!r.ok)throw new Error(r.status+'');return r.json()}

/* ── Main refresh ── */
async function refresh(){
  cd=30;document.getElementById('cdFill').style.width='100%';
  try{
    var bot=await fetchJ(API+'/bots/'+BID);
    lastBot=bot;
    var isSubOnly=bot.isSubscriber&&!bot.isScout;

    /* Toggle scout vs subscriber views */
    document.getElementById('scoutTabs').style.display=isSubOnly?'none':'';
    document.getElementById('subscriberView').style.display=isSubOnly?'':'none';
    for(var ti=0;ti<4;ti++){var tp=document.getElementById('t'+ti);if(tp)tp.style.display=isSubOnly?'none':''}

    if(isSubOnly){
      refreshSubscriber(bot);
      return;
    }

    var res=await Promise.all([
      fetchJ(API+'/bots/'+BID+'/logs/polls?limit=100'),
      fetchJ(API+'/bots/'+BID+'/logs/reschedules?limit=20'),
      fetchJ(API+'/bots/'+BID+'/logs/cas-prefetch?limit=15'),
      fetchJ(API+'/bots/'+BID+'/logs/polls/summary?hours=24'),
      fetchJ(API+'/bots/'+BID+'/logs/polls/cancellations?hours=24'),
      fetchJ(API+'/bots/'+BID+'/logs/polls/health?minutes=15').catch(function(){return null})
    ]);
    var polls=res[0],rss=res[1],casLogs=res[2],summary=res[3],cancelServer=res[4],health=res[5];
    lastPolls=polls;lastSummary=summary;tlData=cancelServer;

    /* Country flag */
    var cc=bot.locale?bot.locale.split('-')[1]:'';
    var cm=CMETA[cc];
    document.getElementById('botFlag').textContent=cm?cm.flag:'';
    document.title=(cm?cm.flag+' ':'')+'Bot #'+BID+' — '+(cm?cm.name:'');

    /* Show scout strip items */
    document.getElementById('sesAge').parentElement.style.display='';
    document.getElementById('proxyVal').parentElement.style.display='';
    document.getElementById('pollSrc').parentElement.style.display='';
    var seps=document.querySelectorAll('.strip .sep');
    for(var si=0;si<seps.length;si++)seps[si].style.display='';

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
    var hasCas=bot.ascFacilityId&&bot.ascFacilityId!=='';
    document.getElementById('casRow').style.display=hasCas?'':'none';
    document.getElementById('casTabBtn').style.display=hasCas?'':'none';
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
    if(bot.maxReschedules!=null){
      rsLimitRow.style.display='';
      var used=bot.rescheduleCount||0;var mx=bot.maxReschedules;var rem=mx-used;
      var pctU=Math.min(100,Math.round(used/mx*100));
      var rc=rem<=0?'var(--red)':rem===1?'var(--amber)':'var(--green)';
      var bar='<span class="limits"><span class="bar" style="max-width:48px"><span class="fill" style="width:'+pctU+'%;background:'+rc+'"></span></span></span>';
      rsLimitVal.innerHTML='<span style="color:'+rc+';font-size:13px;font-weight:800">'+rem+'</span>'
        +'<span style="color:var(--muted);font-size:10px"> restante'+(rem!==1?'s':'')+'</span>'
        +' <span style="color:var(--dim);font-size:9px">('+used+'/'+mx+')</span> '+bar;
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
        var errTip=p.error&&(p.status==='tcp_blocked'||p.status==='error'||p.status==='soft_ban'||p.status==='econnrefused')?' <span onclick="showMsgOverlay('+JSON.stringify(p.error)+')" style="font-size:8px;color:var(--muted);cursor:pointer;text-decoration:underline dotted">'+escH(p.error.substring(0,40))+(p.error.length>40?'…':'')+'</span>':'';
        var statusBadge=p.status==='tcp_blocked'?'<span class="b b-tcp_blocked" title="IP bloqueada — retry +30min (45→60min si persiste)">tcp_blocked</span>':badge(p.status);
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
  document.getElementById('ppSummary').textContent=
    'ok: '+healthyCount+'/'+ipKeys.length+' · '+state.totalPolls+' polls/'+state.windowHours+'h'+(badCount?' · '+badCount+' degraded':'');

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
    html+='<span style="font-size:9px;color:var(--muted)">blk:'+h.tcpBlockedRate+'%</span>';
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
  if(st==='active'){
    el.style.display='flex';
    el.innerHTML='<button class="btn btn-r" onclick="botAct(\\'pause\\')">pausar</button>';
  }else if(st==='paused'){
    el.style.display='flex';
    el.innerHTML='<button class="btn btn-g" onclick="botAct(\\'resume\\')">reanudar</button>';
  }else if(st==='error'||st==='login_required'||st==='created'){
    el.style.display='flex';
    el.innerHTML='<button class="btn btn-c" onclick="botAct(\\'activate\\')">activar</button>';
  }else{el.style.display='none'}
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
  calIdx=0;calPollList=null;
  var list=getCalPolls();
  if(list.length>0)autoScrollToEarliestDate(list[0]);
  renderCalendar();
}

function getCalPolls(){
  if(calPollList)return calPollList;
  if(!lastPolls)return[];

  /* Use topDates instead of allDates (allDates omitted to reduce egress) */
  var withDates=[];
  for(var i=0;i<lastPolls.length;i++){
    var p=lastPolls[i];
    if((p.topDates&&p.topDates.length>0)||p.earliestDate)withDates.push(p);
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

  var data=buildCancelData();
  if(!data){
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
    (burstStr?'<br><span style="color:var(--cyan);font-size:9px">bursts: '+burstStr+'</span>':'');

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

/* ── Subscriber refresh ── */
async function refreshSubscriber(bot){
  /* Country flag */
  var cc=bot.locale?bot.locale.split('-')[1]:'';
  var cm=CMETA[cc];
  document.getElementById('botFlag').textContent=cm?cm.flag:'';
  document.title=(cm?cm.flag+' ':'')+'Bot #'+BID+' — subscriber';

  /* Status chip */
  var sc=document.getElementById('statusChip');
  sc.textContent=bot.status;sc.className='chip chip-'+bot.status;
  renderActions(bot.status);

  /* Hide scout-only strip items */
  document.getElementById('sesAge').parentElement.style.display='none';
  document.getElementById('proxyVal').parentElement.style.display='none';
  document.getElementById('pollSrc').parentElement.style.display='none';
  /* Hide separators after status chip — keep first one for err */
  var seps=document.querySelectorAll('.strip .sep');
  if(seps[0])seps[0].style.display='';
  for(var si=1;si<seps.length;si++)seps[si].style.display='none';
  var ec=document.getElementById('errCount');
  ec.textContent=bot.consecutiveErrors||'0';
  ec.style.color=bot.consecutiveErrors>0?'var(--red)':'var(--green)';

  /* Countdown phase */
  document.getElementById('cdPhase').textContent='SUBSCRIBER';

  /* Appointment */
  var cd2=bot.currentConsularDate;
  document.getElementById('conDate').innerHTML=fmtD(cd2)+(bot.currentConsularTime?' '+bot.currentConsularTime:'');
  document.getElementById('conDays').textContent=daysUntil(cd2);
  var hasCas=bot.ascFacilityId&&bot.ascFacilityId!=='';
  document.getElementById('casRow').style.display=hasCas?'':'none';
  if(hasCas){
    document.getElementById('casDate').innerHTML=fmtD(bot.currentCasDate)+(bot.currentCasTime?' '+bot.currentCasTime:'');
    document.getElementById('casDays').textContent=daysUntil(bot.currentCasDate);
  }

  /* Config card */
  var cfgHtml='';
  cfgHtml+='<div class="sub-kv"><span class="sub-k">locale</span><span class="sub-v">'+(bot.locale||'es-co')+'</span></div>';
  cfgHtml+='<div class="sub-kv"><span class="sub-k">facility</span><span class="sub-v">'+(bot.consularFacilityId||'--')+(hasCas?' + ASC '+(bot.ascFacilityId||''):'')+'</span></div>';
  if(bot.targetDateBefore){
    cfgHtml+='<div class="sub-kv"><span class="sub-k">target</span><span class="sub-v" style="color:var(--amber)">antes de '+fmtD(bot.targetDateBefore)+'</span></div>';
  }
  if(bot.maxReschedules!=null){
    var pct=Math.min(100,Math.round((bot.rescheduleCount||0)/bot.maxReschedules*100));
    var barColor=pct>=100?'var(--red)':pct>=50?'var(--amber)':'var(--green)';
    var atLimit=pct>=100;
    cfgHtml+='<div class="sub-kv"><span class="sub-k">reschedules</span><span class="sub-v"><span class="sub-limits">'
      +(bot.rescheduleCount||0)+'/'+bot.maxReschedules
      +(atLimit?' <span style="color:var(--red);font-size:9px">LIMITE</span>':'')
      +' <span class="sub-limits-bar"><span class="sub-limits-fill" style="width:'+pct+'%;background:'+barColor+'"></span></span>'
      +'</span></span></div>';
  }
  var exRanges=bot.excludedDateRanges||[];
  if(exRanges.length>0){
    var exStr=exRanges.map(function(r){return fmtD(r.startDate)+' - '+fmtD(r.endDate)}).join(', ');
    cfgHtml+='<div class="sub-kv"><span class="sub-k">exclusiones</span><span class="sub-v" style="font-size:10px;font-weight:400">'+exStr+'</span></div>';
  }
  document.getElementById('subConfig').innerHTML=cfgHtml;

  /* Scout status */
  var scoutEl=document.getElementById('subScout');
  if(bot.scoutInfo){
    var si=bot.scoutInfo;
    var scoutAlive=si.status==='active';
    var scoutAgo=si.lastPollAt?sesStr(si.lastPollAt):'nunca';
    var dotColor=scoutAlive?'var(--green)':'var(--red)';
    var scoutHtml='<div class="sub-scout-status">';
    scoutHtml+='<span class="sub-scout-dot" style="background:'+dotColor+'"></span>';
    scoutHtml+='<span style="font-weight:700;color:var(--bright)">Bot #'+si.id+'</span>';
    scoutHtml+='<span class="chip chip-'+si.status+'" style="font-size:8px">'+si.status+'</span>';
    scoutHtml+='</div>';
    scoutHtml+='<div style="font-size:10px;color:var(--muted)">ultimo poll: <span style="color:'+(scoutAlive?'var(--green)':'var(--red)')+'">'+scoutAgo+'</span></div>';
    scoutEl.innerHTML=scoutHtml;
  }else{
    scoutEl.innerHTML='<div style="color:var(--red);font-size:11px">sin scout activo para facility '+(bot.consularFacilityId||'?')+'</div>';
  }

  /* Fetch subscriber-specific data */
  var subRes=await Promise.all([
    fetchJ(API+'/bots/'+BID+'/logs/reschedules?limit=20'),
    fetchJ(API+'/bots/'+BID+'/logs/dispatches/received?limit=20')
  ]);
  var rss=subRes[0],dispatches=subRes[1];

  /* Dispatches */
  var dEl=document.getElementById('subDispatches');
  var dEmpty=document.getElementById('subDispEmpty');
  if(dispatches.length===0){dEl.innerHTML='';dEmpty.style.display=''}
  else{
    dEmpty.style.display='none';
    var dh='';
    for(var i=0;i<dispatches.length;i++){
      var dp=dispatches[i];var dt=dp.detail;
      var resColor=dt.result==='success'?'var(--green)':dt.result==='failed'?'var(--red)':'var(--muted)';
      var actionLabel=dt.action==='attempted'?(dt.result||'--'):(dt.action||'--');
      dh+='<div class="sub-disp-item">';
      dh+='<div style="display:flex;justify-content:space-between;align-items:center">';
      dh+='<span style="color:var(--bright)">'+fmtTime(dp.createdAt)+'</span>';
      dh+='<span>'+badge(actionLabel,dt.result==='success'?'success':dt.action==='attempted'?'fail':'filtered_out')+'</span>';
      dh+='</div>';
      if(dp.availableDates&&dp.availableDates.length>0){
        dh+='<div class="sub-disp-dates">fechas: '+dp.availableDates.slice(0,3).map(function(d){return fmtDs(d)}).join(', ')+(dp.availableDates.length>3?' +'+( dp.availableDates.length-3)+' mas':'')+'</div>';
      }
      var timingParts=[];
      if(dt.loginMs)timingParts.push('login '+dt.loginMs+'ms');
      if(dt.rescheduleMs)timingParts.push('reschedule '+dt.rescheduleMs+'ms');
      if(dt.newDate)timingParts.push(fmtDs(dt.currentDate)+' → '+fmtDs(dt.newDate));
      if(dt.failReason)timingParts.push('<span style="color:var(--red)">'+dt.failReason+'</span>');
      if(timingParts.length>0)dh+='<div class="sub-disp-timing">'+timingParts.join(' · ')+'</div>';
      dh+='</div>';
    }
    dEl.innerHTML=dh;
  }

  /* Reschedules */
  var rl=document.getElementById('subReschedules');
  var re=document.getElementById('subRsEmpty');
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
}

tickClock();refresh();
setInterval(tickClock,1000);
setInterval(tickCd,1000);
setInterval(refresh,30000);
document.querySelector('.hdr').addEventListener('click',function(){refresh()});
window.addEventListener('resize',function(){
  if(lastPolls&&lastBot)drawChart(lastPolls,lastBot.currentConsularDate,lastSummary,chartMode);
  renderTimelines();
});
</script>
</body>
</html>`;
}
