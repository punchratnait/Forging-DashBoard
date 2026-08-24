/* =========================================================================
   PRF FORGING DASHBOARD
   Single-file app. Data persisted via window.storage (shared across users).
   ========================================================================= */

/* =========================================================================
   SUPABASE CONFIG — required for this self-hosted build
   1. Create a free project at https://supabase.com
   2. In the SQL Editor, run the setup script from SETUP.sql (provided
      alongside this file) to create the kv_store table.
   3. Go to Project Settings → API and copy your Project URL and anon public
      key into the two constants below.
   ========================================================================= */
const SUPABASE_URL = 'https://dneaugurejuqcubfbwij.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRuZWF1Z3VyZWp1cWN1YmZid2lqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNDIzMDQsImV4cCI6MjEwMTcxODMwNH0.SWQN85VkfjALNMiQPAVKfZLG1YRNo7ovasd4SGuTpxM';
const CONFIGURED = !SUPABASE_URL.startsWith('YOUR_') && !SUPABASE_ANON_KEY.startsWith('YOUR_');
const supabaseClient = CONFIGURED ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

/* Which URL/page is loading this shared app? Set by an inline script in
   each HTML shell BEFORE this file loads: window.PRF_PAGE_VIEW = 'entry' | 'dashboard' | 'admin' */
const PAGE_VIEW = window.PRF_PAGE_VIEW || 'admin';

/* Department Heads always see all locations, even if a location was accidentally assigned to their account. */
function effectiveLocationId(){
  if(!SESSION) return '';
  if(SESSION.role === 'head') return '';
  return SESSION.locationId || '';
}

function pageAllowedRoutes(){
  if(PAGE_VIEW === 'entry') return ['newentry','entrylog'];
  if(PAGE_VIEW === 'dashboard') return ['dashboard'];
  // 'admin' (full) view — role-based rules
  if(SESSION && SESSION.role === 'admin') return ['dashboard','newentry','entrylog','masterdata','reports'];
  if(SESSION && SESSION.role === 'head') return ['dashboard','newentry','entrylog','reports'];
  return ['dashboard','newentry','entrylog'];
}

const STORE_KEYS = {
  users:'prf_users', machines:'prf_machines', items:'prf_items',
  spm:'prf_machine_item_spm', locations:'prf_locations', sites:'prf_sites',
  shifts:'prf_shifts', reasons:'prf_downtime_reasons', entries:'prf_entries'
};

let DB = { users:[], machines:[], items:[], spm:[], locations:[], sites:[], shifts:[], reasons:[], entries:[] };
let SESSION = null; // {id, name, role}
let ROUTE = 'dashboard';
let BOOTED = false;
let LOGIN_ERR = ''; let LOGIN_MODE = 'login'; // login | forgot-q | forgot-admin | forgot-answer
let FORGOT_USER = null;

function uid(prefix){ return prefix + '_' + Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4); }

async function sha256(text){
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function loadAll(){
  try{
    const { data, error } = await supabaseClient.from('kv_store').select('key,value');
    if(error){ console.error('supabase load error', error); return; }
    const map = {};
    (data||[]).forEach(row=>{ map[row.key] = row.value; });
    Object.keys(STORE_KEYS).forEach(k=>{ DB[k] = map[STORE_KEYS[k]] || []; });
  }catch(e){ console.error('supabase load exception', e); }
}

async function save(key){
  try{
    const { error } = await supabaseClient
      .from('kv_store')
      .upsert({ key: STORE_KEYS[key], value: DB[key], updated_at: new Date().toISOString() });
    if(error){ console.error('supabase save error', error); return false; }
    return true;
  }catch(e){ console.error('supabase save exception', e); return false; }
}

async function seedIfEmpty(){
  let changed = false;
  if(DB.users.length===0){
    const hash = await sha256('admin123');
    const secA = await sha256('forging');
    DB.users.push({id:'admin', name:'Administrator', role:'admin', passwordHash:hash, securityQ:'What is the plant name?', securityAHash:secA});
    changed = true;
  }
  if(DB.sites.length===0){ DB.sites.push({id:uid('site'),name:'Site A'}); changed = true; }
  if(DB.locations.length===0){ DB.locations.push({id:uid('loc'),name:'Forging Bay 1'}); changed = true; }
  if(DB.shifts.length===0){
    DB.shifts.push({id:uid('sh'),name:'Shift A (6-2)',startTime:'06:00',durationMinutes:480,breakMinutes:30});
    DB.shifts.push({id:uid('sh'),name:'Shift B (2-10)',startTime:'14:00',durationMinutes:480,breakMinutes:30});
    DB.shifts.push({id:uid('sh'),name:'Shift C (10-6)',startTime:'22:00',durationMinutes:480,breakMinutes:30});
    changed = true;
  }
  if(DB.reasons.length===0){
    ['Machine Breakdown','Die Change','Material Shortage','Power Failure','Planned Maintenance','No Operator'].forEach(n=>DB.reasons.push({id:uid('dtr'),name:n}));
    changed = true;
  }
  if(DB.machines.length===0){ DB.machines.push({id:uid('mc'), name:'Press-01', site: DB.sites[0]?.id||'', location: DB.locations[0]?.id||''}); changed = true; }
  if(DB.items.length===0){ DB.items.push({id:uid('it'), name:'Flange Blank'}); changed = true; }
  if(DB.spm.length===0 && DB.machines[0] && DB.items[0]){
    DB.spm.push({id:uid('spm'), machineId:DB.machines[0].id, itemId:DB.items[0].id, spm:12});
    changed = true;
  }
  if(changed){
    await Promise.all(Object.keys(STORE_KEYS).map(k=>save(k)));
  }
}

/* ---------------- helpers: lookups & calc ---------------- */
function byId(arr,id){ return arr.find(x=>x.id===id); }
function nameOf(arr,id){ const o=byId(arr,id); return o? o.name : '—'; }
function machineCodeOf(id){ const m=byId(DB.machines,id); return m ? (m.machineCode || '—') : '—'; }
function itemCodeOf(id){ const it=byId(DB.items,id); return it ? (it.itemCode || '—') : '—'; }

function fmt1(n){ return (Math.round(n*10)/10).toFixed(1); }
function safeDiv(a,b){ return b>0 ? a/b : 0; }

function entryWeightGrams(e){
  const item = byId(DB.items, e.itemId);
  const wpp = item ? Number(item.weightPerPiece)||0 : 0;
  if(wpp > 0) return (Number(e.qty)||0) * wpp; // always trust current master data over stored value
  return Number(e.weight)||0; // fallback only if item has no Weight/Pc set
}

/* ---------------- down time blocks (multiple reasons per entry, by clock time) ---------------- */
function computeBlockMinutes(from, to){
  if(!from || !to) return 0;
  const [fh,fm] = from.split(':').map(Number);
  const [th,tm] = to.split(':').map(Number);
  if(isNaN(fh)||isNaN(fm)||isNaN(th)||isNaN(tm)) return 0;
  let mins = (th*60+tm) - (fh*60+fm);
  if(mins < 0) mins += 24*60; // crosses midnight
  return mins;
}
function timeToMin(t){
  if(!t) return null;
  const [h,m] = t.split(':').map(Number);
  if(isNaN(h)||isNaN(m)) return null;
  return h*60+m;
}
/* Returns true if timeStr falls within [shift.startTime, shift.startTime + durationMinutes],
   correctly handling shifts that cross midnight. Returns true (permissive) if the shift
   has no startTime configured yet, so unset shifts never silently block entries. */
function isTimeWithinShift(timeStr, shift){
  if(!timeStr || !shift || !shift.startTime) return true;
  const startMin = timeToMin(shift.startTime);
  const durationMin = Number(shift.durationMinutes)||0;
  if(startMin===null || durationMin<=0) return true;
  const endMin = startMin + durationMin;
  let t = timeToMin(timeStr);
  if(t===null) return true;
  if(t < startMin) t += 24*60; // treat as the following day if earlier than shift start
  return t >= startMin && t <= endMin;
}
function downtimeSummaryText(e){
  if(e.downtimeBlocks && e.downtimeBlocks.length){
    const parts = e.downtimeBlocks.filter(b=>(Number(b.minutes)||0) > 0).map(b=>{
      const label = b.reasonId ? nameOf(DB.reasons,b.reasonId) : 'Unspecified';
      const time = (b.from && b.to) ? ` ${b.from}-${b.to}` : '';
      return `${label} (${b.minutes}m${time})`;
    });
    return parts.length ? parts.join(', ') : '—';
  }
  if(e.downtimeReasonId && Number(e.downtimeMinutes)>0){
    return `${nameOf(DB.reasons,e.downtimeReasonId)} (${e.downtimeMinutes}m)`;
  }
  return Number(e.downtimeMinutes)>0 ? `Unspecified (${e.downtimeMinutes}m)` : '—';
}
function downtimeSummaryHtml(e){
  if(e.downtimeBlocks && e.downtimeBlocks.length){
    const parts = e.downtimeBlocks.filter(b=>(Number(b.minutes)||0) > 0);
    if(parts.length === 0) return '—';
    const lineFor = (b)=>{
      const label = b.reasonId ? nameOf(DB.reasons,b.reasonId) : 'Unspecified';
      const time = (b.from && b.to) ? ` ${b.from}–${b.to}` : '';
      return `${label} (${b.minutes}m${time})`;
    };
    if(parts.length === 1) return lineFor(parts[0]);
    const total = parts.reduce((s,b)=>s+(Number(b.minutes)||0),0);
    const detailLines = parts.map(b=>`<div style="padding:2px 0;">${lineFor(b)}</div>`).join('');
    return `<details class="dt-details"><summary>${parts.length} reasons · ${total}m</summary>${detailLines}</details>`;
  }
  if(e.downtimeReasonId && Number(e.downtimeMinutes)>0){
    return `${nameOf(DB.reasons,e.downtimeReasonId)} (${e.downtimeMinutes}m)`;
  }
  return Number(e.downtimeMinutes)>0 ? `Unspecified (${e.downtimeMinutes}m)` : '—';
}

function entryCalc(e){
  const shift = byId(DB.shifts, e.shiftId);
  const breakMin = shift ? Number(shift.breakMinutes)||0 : 0;
  const available = shift ? Math.max(shift.durationMinutes - breakMin, 0) : 0;
  const downtime = Number(e.downtimeMinutes)||0;
  const runTime = Math.max(available - downtime, 0);
  const spm = Number(e.spm)||0;
  const qty = Number(e.qty)||0;
  const rejected = Number(e.rejectedQty)||0;
  const goodQty = Math.max(qty - rejected, 0);
  const standardQty = spm * runTime;
  const forgingPct = safeDiv(qty, standardQty) * 100;
  const availability = safeDiv(runTime, available);
  const performance = safeDiv(qty, standardQty);
  const quality = qty>0 ? safeDiv(goodQty, qty) : 1;
  const oeePct = availability * performance * quality * 100;
  const downtimePct = safeDiv(downtime, available) * 100;
  return { available, downtime, runTime, standardQty, forgingPct, oeePct, downtimePct, goodQty };
}

function aggregate(entries){
  if(entries.length===0) return { forgingPct:0, oeePct:0, downtimePct:0, totalQty:0, totalWeightKg:0, totalDowntime:0, totalAvailable:0 };
  let sumStd=0, sumQty=0, sumAvail=0, sumRun=0, sumGood=0, sumDown=0, sumWeightG=0;
  entries.forEach(e=>{
    const c = entryCalc(e);
    sumStd += c.standardQty; sumQty += Number(e.qty)||0; sumAvail += c.available;
    sumRun += c.runTime; sumGood += c.goodQty; sumDown += c.downtime;
    sumWeightG += entryWeightGrams(e);
  });
  const forgingPct = safeDiv(sumQty, sumStd) * 100;
  const availability = safeDiv(sumRun, sumAvail);
  const performance = safeDiv(sumQty, sumStd);
  const quality = sumQty>0 ? safeDiv(sumGood, sumQty) : 1;
  const oeePct = availability * performance * quality * 100;
  const downtimePct = safeDiv(sumDown, sumAvail) * 100;
  return { forgingPct, oeePct, downtimePct, totalQty:sumQty, totalWeightKg:sumWeightG/1000, totalDowntime:sumDown, totalAvailable:sumAvail };
}

function buildMachineSummary(entries){
  const byMachine = {};
  entries.forEach(e=>{
    if(!byMachine[e.machineId]) byMachine[e.machineId] = [];
    byMachine[e.machineId].push(e);
  });
  return Object.keys(byMachine).map(mid=>{
    const machineEntries = byMachine[mid];
    const a = aggregate(machineEntries);
    const actualQty = machineEntries.reduce((s,e)=>s+(Number(e.qty)||0),0);
    let plannedQty = 0;
    const lossMap = {};
    machineEntries.forEach(e=>{
      const c = entryCalc(e);
      plannedQty += (Number(e.spm)||0) * c.available;
      if(e.downtimeBlocks && e.downtimeBlocks.length){
        e.downtimeBlocks.forEach(b=>{
          const mins = Number(b.minutes)||0;
          if(mins > 0){
            const key = b.reasonId || '__unspecified';
            lossMap[key] = (lossMap[key]||0) + mins;
          }
        });
      } else {
        const dt = Number(e.downtimeMinutes)||0;
        if(dt > 0){
          const key = e.downtimeReasonId || '__unspecified';
          lossMap[key] = (lossMap[key]||0) + dt;
        }
      }
    });
    const lossParts = Object.keys(lossMap)
      .sort((x,y)=>lossMap[y]-lossMap[x])
      .map(key=>{
        const label = key==='__unspecified' ? 'Unspecified' : nameOf(DB.reasons, key);
        return `${label}: ${lossMap[key]}m`;
      });
    return { mid, plannedQty:Math.round(plannedQty), actualQty, weightKg:fmt1(a.totalWeightKg), oeePct:a.oeePct, downtimePct:a.downtimePct, lossText: lossParts.length ? lossParts.join(', ') : '—' };
  }).sort((x,y)=>y.actualQty-x.actualQty);
}

function inRange(dateStr, start, end){
  return dateStr >= start && dateStr <= end;
}
function todayStr(){ return new Date().toISOString().slice(0,10); }
function monthStartStr(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-01'; }
function yearStartStr(){ const d=new Date(); return d.getFullYear()+'-01-01'; }

/* ---------------- gauge svg ---------------- */
function gaugeSvg(pct, color){
  const clamped = Math.max(0, Math.min(pct, 130));
  const angle = Math.min(clamped,100)/100 * 180;
  const r = 54, cx=60, cy=60;
  // needle tip angle: 0% points left (180deg), 100% points right (0deg)
  const needleAngleDeg = 180 - angle;
  const rad2 = needleAngleDeg * Math.PI/180;
  const tipX = cx + (r-8) * Math.cos(rad2);
  const tipY = cy - (r-8) * Math.sin(rad2);
  return `
  <svg width="120" height="72" viewBox="0 0 120 72">
    <path d="M 6 60 A 54 54 0 0 1 114 60" fill="none" stroke="#34383e" stroke-width="9" stroke-linecap="round"/>
    <path d="M 6 60 A 54 54 0 0 1 114 60" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${(Math.min(clamped,100)/100)*169.6} 999"/>
    <line x1="60" y1="60" x2="${tipX}" y2="${tipY}" stroke="#ecece7" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="60" cy="60" r="4" fill="#ecece7"/>
  </svg>`;
}
function kpiColor(pct){ return pct>=85? 'var(--green)' : pct>=60? 'var(--amber)' : 'var(--red)'; }

/* ---------------- render root ---------------- */
function render(){
  const app = document.getElementById('app');
  if(!SESSION){ app.innerHTML = renderLogin(); attachLoginEvents(); return; }
  app.innerHTML = renderShell();
  attachShellEvents();
}

/* ================= LOGIN ================= */
function renderLogin(){
  let body = '';
  if(LOGIN_MODE==='login'){
    body = `
      <form id="loginForm">
        <div class="field"><label>User ID</label><input type="text" id="loginId" autocomplete="username" required></div>
        <div class="field"><label>Password</label><input type="password" id="loginPw" autocomplete="current-password" required></div>
        ${LOGIN_ERR ? `<div class="login-err">${LOGIN_ERR}</div>` : ''}
        <button class="btn btn-block" type="submit">Sign In</button>
        <div class="login-alt">
          <button type="button" class="link-btn" id="gotoForgot">Forgot password?</button>
        </div>
      </form>`;
  } else if(LOGIN_MODE==='forgot-q'){
    body = `
      <form id="forgotIdForm">
        <div class="field"><label>Enter your User ID</label><input type="text" id="forgotId" required></div>
        ${LOGIN_ERR ? `<div class="login-err">${LOGIN_ERR}</div>` : ''}
        <button class="btn btn-block" type="submit">Continue</button>
        <div class="login-alt"><button type="button" class="link-btn" id="backToLogin">Back to sign in</button></div>
      </form>`;
  } else if(LOGIN_MODE==='forgot-answer'){
    body = `
      <form id="forgotAnswerForm">
        <div class="field"><label>Security Question</label>
          <div style="font-size:13px;color:var(--ink);padding:8px 0;">${FORGOT_USER.securityQ}</div>
        </div>
        <div class="field"><label>Your Answer</label><input type="text" id="secAnswer" required></div>
        <div class="field"><label>New Password</label><input type="password" id="newPw1" required minlength="4"></div>
        <div class="field"><label>Confirm New Password</label><input type="password" id="newPw2" required minlength="4"></div>
        ${LOGIN_ERR ? `<div class="login-err">${LOGIN_ERR}</div>` : ''}
        <button class="btn btn-block" type="submit">Reset Password</button>
        <div class="login-alt">
          <button type="button" class="link-btn" id="tryAdminReset">Ask admin instead</button>
          <button type="button" class="link-btn" id="backToLogin2">Back</button>
        </div>
      </form>`;
  } else if(LOGIN_MODE==='forgot-admin'){
    body = `
      <div>
        <div class="login-ok">A password reset request has been noted. Please contact your Administrator — they can set a temporary password for your account under <b>Master Data → Supervisor Accounts</b>.</div>
        <button class="btn btn-block btn-ghost" id="backToLogin3" type="button">Back to sign in</button>
      </div>`;
  }
  return `
  <div class="login-wrap">
    <div class="login-card">
      <div class="brand-eyebrow">Production Reporting Format</div>
      <div class="brand-title">PRF Forging<br>Dashboard</div>
      <div class="brand-sub">Shop-floor production entry &amp; performance tracking</div>
      ${body}
    </div>
  </div>`;
}

function attachLoginEvents(){
  const loginForm = document.getElementById('loginForm');
  if(loginForm) loginForm.onsubmit = async (ev)=>{
    ev.preventDefault();
    const id = document.getElementById('loginId').value.trim();
    const pw = document.getElementById('loginPw').value;
    const user = DB.users.find(u=>u.id.toLowerCase()===id.toLowerCase());
    if(!user){ LOGIN_ERR='No account found with that User ID.'; render(); return; }
    const hash = await sha256(pw);
    if(hash !== user.passwordHash){ LOGIN_ERR='Incorrect password.'; render(); return; }
    LOGIN_ERR=''; SESSION = {id:user.id, name:user.name, role:user.role, locationId:user.locationId||''}; ROUTE = pageAllowedRoutes()[0];
    resetInactivityTimer();
    render();
  };
  const gotoForgot = document.getElementById('gotoForgot');
  if(gotoForgot) gotoForgot.onclick = ()=>{ LOGIN_MODE='forgot-q'; LOGIN_ERR=''; render(); };
  const backToLogin = document.getElementById('backToLogin');
  if(backToLogin) backToLogin.onclick = ()=>{ LOGIN_MODE='login'; LOGIN_ERR=''; render(); };
  const backToLogin2 = document.getElementById('backToLogin2');
  if(backToLogin2) backToLogin2.onclick = ()=>{ LOGIN_MODE='login'; LOGIN_ERR=''; render(); };
  const backToLogin3 = document.getElementById('backToLogin3');
  if(backToLogin3) backToLogin3.onclick = ()=>{ LOGIN_MODE='login'; LOGIN_ERR=''; render(); };
  const forgotIdForm = document.getElementById('forgotIdForm');
  if(forgotIdForm) forgotIdForm.onsubmit = (ev)=>{
    ev.preventDefault();
    const id = document.getElementById('forgotId').value.trim();
    const user = DB.users.find(u=>u.id.toLowerCase()===id.toLowerCase());
    if(!user){ LOGIN_ERR='No account found with that User ID.'; render(); return; }
    FORGOT_USER = user; LOGIN_ERR=''; LOGIN_MODE='forgot-answer'; render();
  };
  const tryAdminReset = document.getElementById('tryAdminReset');
  if(tryAdminReset) tryAdminReset.onclick = ()=>{ LOGIN_MODE='forgot-admin'; render(); };
  const forgotAnswerForm = document.getElementById('forgotAnswerForm');
  if(forgotAnswerForm) forgotAnswerForm.onsubmit = async (ev)=>{
    ev.preventDefault();
    const ans = document.getElementById('secAnswer').value.trim();
    const p1 = document.getElementById('newPw1').value;
    const p2 = document.getElementById('newPw2').value;
    if(p1 !== p2){ LOGIN_ERR='Passwords do not match.'; render(); return; }
    const ansHash = await sha256(ans.toLowerCase());
    if(ansHash !== FORGOT_USER.securityAHash){ LOGIN_ERR='Answer did not match our records.'; render(); return; }
    FORGOT_USER.passwordHash = await sha256(p1);
    await save('users');
    LOGIN_MODE='login'; LOGIN_ERR=''; 
    alert('Password reset successful. Please sign in.');
    render();
  };
}

/* ================= SHELL ================= */
function navItems(){
  const labels = {dashboard:'Dashboard', newentry:'New Entry', entrylog:'Entry Log', masterdata:'Master Data', reports:'Reports'};
  return pageAllowedRoutes().map(key=>({key, label:labels[key]}));
}

function renderShell(){
  const items = navItems();
  const viewLabel = PAGE_VIEW==='entry' ? 'ENTRY TERMINAL' : PAGE_VIEW==='dashboard' ? 'MANAGEMENT VIEW' : 'ADMIN CONSOLE';
  const labels = {dashboard:'Dashboard', newentry:'New Entry', entrylog:'Entry Log', masterdata:'Master Data', reports:'Reports'};
  const nav = items.map(it=>`
    <button class="nav-item ${ROUTE===it.key?'active':''}" data-route="${it.key}">
      <span class="dot"></span><span class="nav-label">${it.label}</span>
    </button>`).join('');
  return `
  <div class="shell">
    <div class="mobile-topbar">
      <button class="mobile-menu-btn" id="mobileMenuBtn" aria-label="Menu">☰</button>
      <span class="mobile-topbar-title">${labels[ROUTE] || 'PRF'}</span>
    </div>
    <div class="sidebar-overlay" id="sidebarOverlay"></div>
    <div class="sidebar" id="sidebarPanel">
      <div class="side-brand">
        <div class="brand-eyebrow">PRF · ${viewLabel}</div>
        <div class="brand-title" style="font-size:20px;">Forging<br>Dashboard</div>
      </div>
      <nav>${nav}</nav>
      <div class="side-foot">
        <div class="who">${SESSION.name}</div>
        <div class="who-role">${SESSION.role}</div>
        ${effectiveLocationId() ? `<div style="font-size:10.5px;color:var(--ink-dim);margin-top:2px;">📍 ${nameOf(DB.locations,effectiveLocationId())}</div>` : ''}
        <button class="btn btn-ghost btn-sm logout-btn" id="logoutBtn">Sign Out</button>
      </div>
    </div>
    <div class="main" id="mainArea">${renderPage()}</div>
  </div>`;
}

function attachShellEvents(){
  document.getElementById('logoutBtn').onclick = ()=>{ if(inactivityTimer) clearTimeout(inactivityTimer); SESSION=null; LOGIN_MODE='login'; render(); };
  const sidebarPanel = document.getElementById('sidebarPanel');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const closeDrawer = ()=>{ sidebarPanel.classList.remove('open'); sidebarOverlay.classList.remove('open'); };
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  if(mobileMenuBtn) mobileMenuBtn.onclick = ()=>{ sidebarPanel.classList.add('open'); sidebarOverlay.classList.add('open'); };
  if(sidebarOverlay) sidebarOverlay.onclick = closeDrawer;
  document.querySelectorAll('.nav-item').forEach(btn=>{
    btn.onclick = ()=>{ ROUTE = btn.dataset.route; closeDrawer(); render(); };
  });
  attachPageEvents();
}

function renderPage(){
  const allowed = pageAllowedRoutes();
  if(!allowed.includes(ROUTE)){ ROUTE = allowed[0]; }
  if(ROUTE==='dashboard') return pageDashboard();
  if(ROUTE==='newentry') return pageNewEntry();
  if(ROUTE==='entrylog') return pageEntryLog();
  if(ROUTE==='masterdata' && SESSION.role==='admin') return pageMasterData();
  if(ROUTE==='reports' && (SESSION.role==='admin' || SESSION.role==='head')) return pageReports();
  ROUTE = allowed[0];
  return renderPage();
}

function attachPageEvents(){
  if(ROUTE==='dashboard') attachDashboardEvents();
  if(ROUTE==='newentry') attachNewEntryEvents();
  if(ROUTE==='entrylog') attachEntryLogEvents();
  if(ROUTE==='masterdata') attachMasterDataEvents();
  if(ROUTE==='reports') attachReportsEvents();
}

/* ================= DASHBOARD ================= */
let dashRangeMode = 'mtd'; // mtd | ytd | custom
let dashCustomStart = monthStartStr();
let dashCustomEnd = todayStr();

function dashRange(){
  if(dashRangeMode==='mtd') return {start:monthStartStr(), end:todayStr()};
  if(dashRangeMode==='ytd') return {start:yearStartStr(), end:todayStr()};
  return {start:dashCustomStart, end:dashCustomEnd};
}

function pageDashboard(){
  const {start,end} = dashRange();
  const scoped = effectiveLocationId() ? DB.entries.filter(e=>e.locationId===effectiveLocationId()) : DB.entries;
  const filtered = scoped.filter(e=>inRange(e.date, start, end));
  const agg = aggregate(filtered);

  const mtdEntries = scoped.filter(e=>inRange(e.date, monthStartStr(), todayStr()));
  const ytdEntries = scoped.filter(e=>inRange(e.date, yearStartStr(), todayStr()));
  const mtd = aggregate(mtdEntries);
  const ytd = aggregate(ytdEntries);

  const machineRows = buildMachineSummary(filtered);

  return `
  <div class="page-head">
    <div>
      <div class="page-eyebrow">Overview</div>
      <div class="page-title">Dashboard</div>
    </div>
    <div class="filter-bar" style="margin-bottom:0;">
      <div class="field"><label>Range</label>
        <select id="dashRangeSel">
          <option value="mtd" ${dashRangeMode==='mtd'?'selected':''}>Month to Date</option>
          <option value="ytd" ${dashRangeMode==='ytd'?'selected':''}>Year to Date</option>
          <option value="custom" ${dashRangeMode==='custom'?'selected':''}>Custom Range</option>
        </select>
      </div>
      ${dashRangeMode==='custom' ? `
        <div class="field"><label>From</label><input type="date" id="dashStart" value="${dashCustomStart}"></div>
        <div class="field"><label>To</label><input type="date" id="dashEnd" value="${dashCustomEnd}"></div>
      ` : ''}
    </div>
  </div>

  <div class="panel">
    <div class="panel-title"><span class="bar"></span>Key Performance (${dashRangeMode==='mtd'?'Month to Date':dashRangeMode==='ytd'?'Year to Date':'Selected Range'})</div>
    <div class="grid-4">
      <div class="kpi-card">
        <div class="gauge-wrap">${gaugeSvg(agg.oeePct, kpiColor(agg.oeePct))}</div>
        <div class="gauge-num">${fmt1(agg.oeePct)}%</div>
        <div class="gauge-cap">OEE %</div>
      </div>
      <div class="kpi-card">
        <div class="gauge-wrap">${gaugeSvg(agg.downtimePct, agg.downtimePct<=15?'var(--green)':agg.downtimePct<=30?'var(--amber)':'var(--red)')}</div>
        <div class="gauge-num">${fmt1(agg.downtimePct)}%</div>
        <div class="gauge-cap">Down Time %</div>
      </div>
      <div class="kpi-card">
        <div style="height:72px;display:flex;align-items:center;justify-content:center;">
          <div class="kpi-value" style="font-size:30px;font-family:var(--mono);color:var(--ink);">${agg.totalQty}</div>
        </div>
        <div class="gauge-cap">Total Production Qty</div>
      </div>
      <div class="kpi-card">
        <div style="height:72px;display:flex;align-items:center;justify-content:center;">
          <div class="kpi-value" style="font-size:30px;font-family:var(--mono);color:var(--ink);">${fmt1(agg.totalWeightKg)}</div>
        </div>
        <div class="gauge-cap">Total Production Weight (kg)</div>
      </div>
    </div>
  </div>

  <div class="grid-2" style="margin-top:18px;">
    <div class="panel">
      <div class="panel-title"><span class="bar"></span>MTD Snapshot</div>
      <table>
        <tbody>
          <tr><td>OEE %</td><td style="text-align:right;font-family:var(--mono);">${fmt1(mtd.oeePct)}%</td></tr>
          <tr><td>Down Time %</td><td style="text-align:right;font-family:var(--mono);">${fmt1(mtd.downtimePct)}%</td></tr>
          <tr><td>Total Production Qty</td><td style="text-align:right;font-family:var(--mono);">${mtd.totalQty}</td></tr>
          <tr><td>Total Production Weight (kg)</td><td style="text-align:right;font-family:var(--mono);">${fmt1(mtd.totalWeightKg)}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="panel">
      <div class="panel-title"><span class="bar"></span>YTD Snapshot</div>
      <table>
        <tbody>
          <tr><td>OEE %</td><td style="text-align:right;font-family:var(--mono);">${fmt1(ytd.oeePct)}%</td></tr>
          <tr><td>Down Time %</td><td style="text-align:right;font-family:var(--mono);">${fmt1(ytd.downtimePct)}%</td></tr>
          <tr><td>Total Production Qty</td><td style="text-align:right;font-family:var(--mono);">${ytd.totalQty}</td></tr>
          <tr><td>Total Production Weight (kg)</td><td style="text-align:right;font-family:var(--mono);">${fmt1(ytd.totalWeightKg)}</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel" style="margin-top:18px;">
    <div class="panel-title"><span class="bar"></span>Machine-wise Production (Selected Range)</div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Machine</th><th>Planned Qty</th><th>Actual Qty</th><th>Weight (kg)</th><th>OEE %</th><th>Losses (Reason: Minutes)</th><th></th></tr></thead>
        <tbody>
          ${machineRows.length===0 ? `<tr class="empty-row"><td colspan="7">No entries in this range.</td></tr>` :
            machineRows.map(r=>`
              <tr>
                <td>${nameOf(DB.machines, r.mid)}</td>
                <td style="font-family:var(--mono);">${r.plannedQty}</td>
                <td style="font-family:var(--mono);">${r.actualQty}</td>
                <td style="font-family:var(--mono);">${r.weightKg}</td>
                <td style="font-family:var(--mono);color:${kpiColor(r.oeePct)};">${fmt1(r.oeePct)}%</td>
                <td style="font-size:12.5px;color:var(--ink-dim);">${r.lossText}</td>
                <td><button class="btn btn-ghost btn-sm" type="button" data-viewmachine="${r.mid}">View Entries</button></td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>
  <div class="footer-note">Formulas: OEE % = Availability × Performance × Quality × 100 (Run Time/Available Time, Actual/Standard Qty, Good Qty/Actual Qty). Down Time % = Down Time ÷ Available Time × 100. Available Time = Shift Duration − Break (both configured per Shift in Master Data), before any logged down time is subtracted. Production Weight = entered Weight where available, otherwise Qty × Item's Weight/Pc, shown in kg. Share your exact formulas any time and these can be adjusted.</div>
  `;
}

function attachDashboardEvents(){
  const sel = document.getElementById('dashRangeSel');
  if(sel) sel.onchange = ()=>{ dashRangeMode = sel.value; render(); };
  const s = document.getElementById('dashStart');
  const eEnd = document.getElementById('dashEnd');
  if(s) s.onchange = ()=>{ dashCustomStart = s.value; render(); };
  if(eEnd) eEnd.onchange = ()=>{ dashCustomEnd = eEnd.value; render(); };

  document.querySelectorAll('[data-viewmachine]').forEach(btn=>{
    btn.onclick = ()=>{
      const {start,end} = dashRange();
      logFilters = { start, end, machineId: btn.dataset.viewmachine, shiftId:'', siteId:'', search:'' };
      ROUTE = 'entrylog';
      render();
    };
  });
}

/* ================= NEW ENTRY ================= */
let entryDraft = null;
let editingEntryId = null;

function blankDraft(){
  const defaultSite = DB.sites.find(s=>s.name==='10001');
  return {
    date: todayStr(), shiftId:'', siteId: defaultSite ? defaultSite.id : '', locationId: effectiveLocationId(), machineId:'', itemId:'',
    spm:'', qty:'', weight:'', rejectedQty:'', downtimeBlocks:[], operatorName: (SESSION && SESSION.name) || '', supervisorId:''
  };
}

function renderOptions(arr, val, placeholder){
  return `<option value="">${placeholder}</option>` + arr.map(o=>`<option value="${o.id}" ${o.id===val?'selected':''}>${o.name}</option>`).join('');
}
function renderItemOptions(arr, val, placeholder){
  return `<option value="">${placeholder}</option>` + arr.map(o=>{
    const label = o.itemCode ? `${o.itemCode} — ${o.name}` : o.name;
    return `<option value="${o.id}" ${o.id===val?'selected':''}>${label}</option>`;
  }).join('');
}
function renderMachineOptions(arr, val, placeholder){
  return `<option value="">${placeholder}</option>` + arr.map(o=>{
    const label = o.machineCode ? `${o.machineCode} — ${o.name}` : o.name;
    return `<option value="${o.id}" ${o.id===val?'selected':''}>${label}</option>`;
  }).join('');
}
function machinesForLocation(locationId){
  if(!locationId) return DB.machines;
  return DB.machines.filter(m=>m.location===locationId);
}
function itemsForMachine(machineId){
  if(!machineId) return DB.items;
  const itemIds = new Set(DB.spm.filter(s=>s.machineId===machineId).map(s=>s.itemId));
  return DB.items.filter(i=>itemIds.has(i.id));
}

function renderDtBlocksHtml(blocks){
  if(!blocks || blocks.length===0){
    return `<div class="helptext">No down time logged for this entry. Click "+ Add Down Time" below if there was any stoppage.</div>`;
  }
  return blocks.map(b=>{
    const mins = (b.from && b.to) ? computeBlockMinutes(b.from,b.to) : (Number(b.minutes)||0);
    return `
    <div class="dt-row-wrap" data-blockid="${b.id}" style="margin-bottom:14px;">
      <div class="dt-row" data-blockid="${b.id}" style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap;">
        <div class="field" style="flex:1; min-width:180px; margin-bottom:0;"><label>Reason</label><select class="dt-reason" data-blockid="${b.id}">${renderOptions(DB.reasons, b.reasonId, 'Select reason')}</select></div>
        <div class="field" style="min-width:110px; margin-bottom:0;"><label>From</label><input type="time" class="dt-from" data-blockid="${b.id}" value="${b.from||''}"></div>
        <div class="field" style="min-width:110px; margin-bottom:0;"><label>To</label><input type="time" class="dt-to" data-blockid="${b.id}" value="${b.to||''}"></div>
        <div class="field" style="min-width:90px; margin-bottom:0;"><label>Minutes</label><input type="text" class="dt-minutes-display" value="${mins}" readonly style="opacity:0.7;"></div>
        <button class="icon-btn danger dt-remove" type="button" data-blockid="${b.id}" title="Remove">✕</button>
      </div>
      <div class="dt-row-error" data-blockid="${b.id}" style="display:none; color:var(--red); font-size:11.5px; margin-top:4px;"></div>
    </div>`;
  }).join('');
}

function pageNewEntry(){
  if(!entryDraft) entryDraft = blankDraft();
  const d = entryDraft;
  const opts = renderOptions;
  return `
  <div class="page-head">
    <div>
      <div class="page-eyebrow">Production Entry</div>
      <div class="page-title">${editingEntryId ? 'Edit Entry' : 'New Entry'}</div>
    </div>
  </div>
  <div class="panel">
    <form id="entryForm">
      <div class="form-row">
        <div class="field"><label>Date</label><input type="date" id="f_date" value="${d.date}" required></div>
        <div class="field"><label>Shift</label><select id="f_shift" required>${opts(DB.shifts, d.shiftId, 'Select shift')}</select></div>
        <div class="field"><label>Site</label><select id="f_site" required>${opts(DB.sites, d.siteId, 'Select site')}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Location</label><select id="f_location" required ${effectiveLocationId()?'disabled':''}>${opts(effectiveLocationId() ? DB.locations.filter(l=>l.id===effectiveLocationId()) : DB.locations, d.locationId, 'Select location')}</select>
          ${effectiveLocationId() ? `<div class="helptext">Locked to your assigned location: ${nameOf(DB.locations,effectiveLocationId())}.</div>` : ''}
        </div>
        <div class="field"><label>Machine</label><select id="f_machine" required>${renderMachineOptions(machinesForLocation(d.locationId), d.machineId, 'Select machine')}</select>
          <div class="helptext">Filtered to machines mapped to the selected location.</div>
        </div>
        <div class="field"><label>Item</label><select id="f_item" required>${renderItemOptions(itemsForMachine(d.machineId), d.itemId, 'Select item')}</select>
          <div class="helptext">Filtered to items mapped (via SPM) to the selected machine.</div>
        </div>
      </div>
      <div class="form-row">
        <div class="field"><label>Item Code</label><input type="text" id="f_itemcode" value="${(byId(DB.items,d.itemId)||{}).itemCode||''}" readonly style="opacity:0.7;"></div>
        <div class="field" style="grid-column:span 2;"><label>Item Description</label><input type="text" id="f_itemdesc" value="${(byId(DB.items,d.itemId)||{}).description||''}" readonly style="opacity:0.7;"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>SPM (auto from Master Data)</label><input type="number" id="f_spm" value="${d.spm}" readonly style="opacity:0.7;"></div>
        <div class="field"><label>Production Qty</label><input type="number" min="0" id="f_qty" value="${d.qty}" required></div>
        <div class="field"><label>Weight Produced (g, auto from Qty × Weight/Pc)</label><input type="number" id="f_weight" value="${d.weight}" readonly style="opacity:0.7;">
          <div class="helptext">If the item has a Weight/Pc set in Master Data, Weight auto-calculates from Qty.</div>
        </div>
      </div>
      <div class="form-row">
        <div class="field"><label>Rejected Qty (optional)</label><input type="number" min="0" id="f_rejected" value="${d.rejectedQty}"></div>
      </div>

      <div class="panel-title" style="margin-top:8px; margin-bottom:12px;"><span class="bar"></span>Down Time Entries</div>
      <div id="dtBlocksContainer">${renderDtBlocksHtml(d.downtimeBlocks)}</div>
      <button class="btn btn-ghost btn-sm" type="button" id="addDtBlockBtn" style="margin-top:4px; margin-bottom:18px;">+ Add Down Time</button>

      <div class="grid-3" style="margin-bottom:18px;">
        <div class="kpi-card"><div class="kpi-label">Total Down Time</div><div class="kpi-value" id="dtTotalDisplay" style="font-size:18px;">0 min</div></div>
        <div class="kpi-card"><div class="kpi-label">Working Time (Shift − Break − Down Time)</div><div class="kpi-value" id="workingTimeDisplay" style="font-size:18px;">—</div></div>
        <div class="kpi-card"><div class="kpi-label">Planned Qty (Working Time × SPM)</div><div class="kpi-value" id="plannedQtyDisplay" style="font-size:18px;">—</div></div>
      </div>
      <div id="qtyValidationMsg" class="login-err" style="display:none; margin-bottom:18px;"></div>

      <div class="form-row">
        <div class="field"><label>Operator Name</label><input type="text" id="f_operator" value="${d.operatorName}" readonly style="opacity:0.7;">
          <div class="helptext">Auto-filled from your login account.</div>
        </div>
        <div class="field"><label>Supervisor</label><select id="f_supervisor" required>${renderOptions(DB.users.filter(u=>u.role==='supervisor'), d.supervisorId, 'Select supervisor')}</select></div>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">${editingEntryId ? 'Update Entry' : 'Save Entry'}</button>
        <button class="btn btn-ghost" type="button" id="clearEntryForm">Clear</button>
      </div>
    </form>
  </div>
  `;
}

function lookupSpm(machineId, itemId){
  const rec = DB.spm.find(s=>s.machineId===machineId && s.itemId===itemId);
  return rec ? rec.spm : '';
}

function attachNewEntryEvents(){
  const locationSel = document.getElementById('f_location');
  const machineSel = document.getElementById('f_machine');
  const itemSel = document.getElementById('f_item');
  const shiftSel = document.getElementById('f_shift');
  const spmInput = document.getElementById('f_spm');
  const weightInput = document.getElementById('f_weight');
  const qtyInput = document.getElementById('f_qty');
  const itemCodeInput = document.getElementById('f_itemcode');
  const itemDescInput = document.getElementById('f_itemdesc');
  const dtContainer = document.getElementById('dtBlocksContainer');
  const addDtBtn = document.getElementById('addDtBlockBtn');
  const dtTotalDisplay = document.getElementById('dtTotalDisplay');
  const workingTimeDisplay = document.getElementById('workingTimeDisplay');
  const plannedQtyDisplay = document.getElementById('plannedQtyDisplay');
  const qtyValidationMsg = document.getElementById('qtyValidationMsg');

  const updateSpm = ()=>{
    const mid = machineSel.value, iid = itemSel.value;
    const spm = lookupSpm(mid, iid);
    spmInput.value = spm;
  };
  const updateItemInfo = ()=>{
    const item = byId(DB.items, itemSel.value);
    itemCodeInput.value = item ? (item.itemCode||'') : '';
    itemDescInput.value = item ? (item.description||'') : '';
  };
  const updateWeightFromQty = ()=>{
    const item = byId(DB.items, itemSel.value);
    const wpp = item ? Number(item.weightPerPiece)||0 : 0;
    const qty = Number(qtyInput.value)||0;
    weightInput.value = wpp > 0 ? Math.round(qty * wpp) : '';
  };

  // ---- Down time blocks + live Planned Qty + 120% validation ----
  let lastPlannedQty = 0;
  let lastDtBlocksValid = true;
  const recomputeSummary = ()=>{
    let total = 0;
    const shift = byId(DB.shifts, shiftSel.value);
    lastDtBlocksValid = true;
    entryDraft.downtimeBlocks.forEach(b=>{
      const fromEl = dtContainer.querySelector(`.dt-from[data-blockid="${b.id}"]`);
      const toEl = dtContainer.querySelector(`.dt-to[data-blockid="${b.id}"]`);
      const reasonEl = dtContainer.querySelector(`.dt-reason[data-blockid="${b.id}"]`);
      if(fromEl) b.from = fromEl.value;
      if(toEl) b.to = toEl.value;
      if(reasonEl) b.reasonId = reasonEl.value;
      b.minutes = (b.from && b.to) ? computeBlockMinutes(b.from, b.to) : (Number(b.minutes)||0);
      total += b.minutes;
      const row = fromEl ? fromEl.closest('.dt-row') : null;
      const mDisplay = row ? row.querySelector('.dt-minutes-display') : null;
      if(mDisplay) mDisplay.value = b.minutes;

      const errorEl = dtContainer.querySelector(`.dt-row-error[data-blockid="${b.id}"]`);
      let rowError = '';
      if(shift && shift.startTime && b.from && b.to){
        const fromOk = isTimeWithinShift(b.from, shift);
        const toOk = isTimeWithinShift(b.to, shift);
        if(!fromOk || !toOk){
          const shiftEndMin = (timeToMin(shift.startTime) + Number(shift.durationMinutes||0)) % (24*60);
          const shiftEndStr = String(Math.floor(shiftEndMin/60)).padStart(2,'0') + ':' + String(shiftEndMin%60).padStart(2,'0');
          rowError = `Time must fall within the shift window (${shift.startTime}–${shiftEndStr}).`;
        }
      }
      if(fromEl) fromEl.style.borderColor = rowError ? 'var(--red)' : '';
      if(toEl) toEl.style.borderColor = rowError ? 'var(--red)' : '';
      if(errorEl){
        errorEl.style.display = rowError ? '' : 'none';
        errorEl.textContent = rowError;
      }
      if(rowError) lastDtBlocksValid = false;
    });
    dtTotalDisplay.textContent = total + ' min';

    const shiftMinutes = shift ? Math.max(shift.durationMinutes - (Number(shift.breakMinutes)||0), 0) : 0;
    const workingMinutes = Math.max(shiftMinutes - total, 0);
    workingTimeDisplay.textContent = shift ? (workingMinutes + ' min') : '—';

    const spmVal = Number(spmInput.value)||0;
    const plannedQty = (shift && spmVal) ? Math.round(workingMinutes * spmVal) : 0;
    plannedQtyDisplay.textContent = plannedQty > 0 ? plannedQty : '—';
    lastPlannedQty = plannedQty;

    validateQty();
    return { total, workingMinutes, plannedQty };
  };

  const validateQty = ()=>{
    const qty = Number(qtyInput.value)||0;
    if(lastPlannedQty <= 0 || qty <= 0){ qtyValidationMsg.style.display = 'none'; return true; }
    const maxAllowed = Math.round(lastPlannedQty * 1.2);
    if(qty > maxAllowed){
      qtyValidationMsg.style.display = '';
      qtyValidationMsg.textContent = `Qty (${qty}) exceeds the allowed limit of ${maxAllowed} pcs — 120% of Planned Qty (${lastPlannedQty} pcs, based on Working Time × SPM). Please recheck the entry or the down time logged.`;
      return false;
    }
    qtyValidationMsg.style.display = 'none';
    return true;
  };

  dtContainer.oninput = (ev)=>{
    if(ev.target.classList.contains('dt-from') || ev.target.classList.contains('dt-to')) recomputeSummary();
  };
  dtContainer.onchange = (ev)=>{
    if(ev.target.classList.contains('dt-reason') || ev.target.classList.contains('dt-from') || ev.target.classList.contains('dt-to')) recomputeSummary();
  };
  dtContainer.onclick = (ev)=>{
    const btn = ev.target.closest('.dt-remove');
    if(!btn) return;
    entryDraft.downtimeBlocks = entryDraft.downtimeBlocks.filter(b=>b.id!==btn.dataset.blockid);
    dtContainer.innerHTML = renderDtBlocksHtml(entryDraft.downtimeBlocks);
    recomputeSummary();
  };
  addDtBtn.onclick = ()=>{
    entryDraft.downtimeBlocks.push({id: uid('dtb'), reasonId:'', from:'', to:'', minutes:0});
    dtContainer.innerHTML = renderDtBlocksHtml(entryDraft.downtimeBlocks);
    recomputeSummary();
  };
  shiftSel.onchange = recomputeSummary;
  qtyInput.oninput = ()=>{ updateWeightFromQty(); recomputeSummary(); };

  locationSel.onchange = ()=>{
    machineSel.innerHTML = renderMachineOptions(machinesForLocation(locationSel.value), '', 'Select machine');
    itemSel.innerHTML = renderItemOptions(itemsForMachine(''), '', 'Select item');
    spmInput.value = '';
    updateItemInfo();
    updateWeightFromQty();
    recomputeSummary();
  };
  machineSel.onchange = ()=>{
    itemSel.innerHTML = renderItemOptions(itemsForMachine(machineSel.value), '', 'Select item');
    spmInput.value = '';
    updateItemInfo();
    updateWeightFromQty();
    recomputeSummary();
  };
  itemSel.onchange = ()=>{ updateSpm(); updateItemInfo(); updateWeightFromQty(); recomputeSummary(); };

  recomputeSummary(); // initialize on load (handles edit mode with pre-filled blocks)

  document.getElementById('clearEntryForm').onclick = ()=>{ entryDraft = blankDraft(); editingEntryId=null; render(); };

  document.getElementById('entryForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    const spmVal = spmInput.value;
    if(!spmVal){ alert('No SPM found for this Machine + Item combination. Please add it under Master Data → SPM first.'); return; }
    const summary = recomputeSummary();
    if(!lastDtBlocksValid){
      alert('One or more Down Time entries fall outside the selected shift\'s time window. Please fix the times highlighted in red before saving.');
      return;
    }
    if(!validateQty()){
      alert(qtyValidationMsg.textContent);
      return;
    }
    const existing = editingEntryId ? DB.entries.find(e=>e.id===editingEntryId) : null;
    const rec = {
      id: editingEntryId || uid('en'),
      date: document.getElementById('f_date').value,
      shiftId: document.getElementById('f_shift').value,
      siteId: document.getElementById('f_site').value,
      locationId: document.getElementById('f_location').value,
      machineId: machineSel.value,
      itemId: itemSel.value,
      spm: Number(spmVal),
      qty: Number(document.getElementById('f_qty').value)||0,
      weight: Number(document.getElementById('f_weight').value)||0,
      rejectedQty: Number(document.getElementById('f_rejected').value)||0,
      downtimeMinutes: summary.total,
      downtimeBlocks: entryDraft.downtimeBlocks.map(b=>({reasonId:b.reasonId, from:b.from, to:b.to, minutes:b.minutes})),
      // Operator is always the account that originally logged in and created this entry —
      // auto-filled at creation, never overwritten even if a different account edits it later.
      operatorName: existing ? existing.operatorName : SESSION.name,
      // Supervisor is a manual selection (who is overseeing this shift's production), editable anytime.
      supervisorId: document.getElementById('f_supervisor').value,
      supervisorName: nameOf(DB.users, document.getElementById('f_supervisor').value),
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      // Audit trail: who last edited it (only set when this is actually an edit)
      lastEditedBy: existing ? SESSION.id : undefined,
      lastEditedByName: existing ? SESSION.name : undefined,
      lastEditedAt: existing ? new Date().toISOString() : undefined
    };
    if(editingEntryId){
      const idx = DB.entries.findIndex(e=>e.id===editingEntryId);
      if(idx>=0) DB.entries[idx] = rec;
    } else {
      DB.entries.push(rec);
    }
    const ok = await save('entries');
    entryDraft = blankDraft(); editingEntryId = null;
    ROUTE = 'entrylog';
    render();
    if(!ok) alert('Warning: entry saved locally but could not sync to shared storage. Please retry.');
  };
}

/* ================= ENTRY LOG ================= */
let logFilters = { start:'', end:'', machineId:'', shiftId:'', siteId:'', search:'' };

function pageEntryLog(){
  let rows = DB.entries.slice().sort((a,b)=> (b.date+b.createdAt).localeCompare(a.date+a.createdAt));
  if(effectiveLocationId()) rows = rows.filter(e=>e.locationId===effectiveLocationId());
  if(logFilters.start) rows = rows.filter(e=>e.date >= logFilters.start);
  if(logFilters.end) rows = rows.filter(e=>e.date <= logFilters.end);
  if(logFilters.machineId) rows = rows.filter(e=>e.machineId===logFilters.machineId);
  if(logFilters.shiftId) rows = rows.filter(e=>e.shiftId===logFilters.shiftId);
  if(logFilters.siteId) rows = rows.filter(e=>e.siteId===logFilters.siteId);
  if(logFilters.search && logFilters.search.trim()){
    const q = logFilters.search.trim().toLowerCase();
    rows = rows.filter(e=>{
      const machine = byId(DB.machines, e.machineId) || {};
      const item = byId(DB.items, e.itemId) || {};
      const haystack = [
        machine.name, machine.machineCode, item.name, item.itemCode,
        e.operatorName, e.supervisorName, nameOf(DB.users,e.supervisorId),
        e.lastEditedByName, downtimeSummaryText(e),
        nameOf(DB.locations,e.locationId), nameOf(DB.sites,e.siteId), nameOf(DB.shifts,e.shiftId)
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }

  const canManage = ()=> SESSION.role==='admin' || SESSION.role==='supervisor' || SESSION.role==='head'; // operators can submit entries but cannot edit/delete any

  return `
  <div class="page-head">
    <div>
      <div class="page-eyebrow">Records</div>
      <div class="page-title">Entry Log</div>
    </div>
  </div>
  <div class="panel">
    <div class="filter-bar">
      <div class="field" style="min-width:220px;"><label>Search</label><input type="text" id="lf_search" placeholder="Operator, item, machine, code..." value="${logFilters.search}"></div>
      <div class="field"><label>From</label><input type="date" id="lf_start" value="${logFilters.start}"></div>
      <div class="field"><label>To</label><input type="date" id="lf_end" value="${logFilters.end}"></div>
      <div class="field"><label>Machine</label><select id="lf_machine"><option value="">All</option>${DB.machines.map(m=>`<option value="${m.id}" ${logFilters.machineId===m.id?'selected':''}>${m.name}</option>`).join('')}</select></div>
      <div class="field"><label>Shift</label><select id="lf_shift"><option value="">All</option>${DB.shifts.map(m=>`<option value="${m.id}" ${logFilters.shiftId===m.id?'selected':''}>${m.name}</option>`).join('')}</select></div>
      <div class="field"><label>Site</label><select id="lf_site"><option value="">All</option>${DB.sites.map(m=>`<option value="${m.id}" ${logFilters.siteId===m.id?'selected':''}>${m.name}</option>`).join('')}</select></div>
      <button class="btn btn-ghost btn-sm" id="lf_clear" type="button">Clear Filters</button>
    </div>
    <div class="table-scroll">
      <table>
        <thead><tr>
          <th>Date</th><th>Shift</th><th>Site</th><th>Location</th><th>Machine Code</th><th>Machine</th><th>Item Code</th><th>Item</th>
          <th>SPM</th><th>Weight (g)</th><th>Qty</th><th>Rej.</th><th>D/T Min</th><th>Reason</th><th>Operator</th><th>Supervisor</th><th></th>
        </tr></thead>
        <tbody>
        ${rows.length===0 ? `<tr class="empty-row"><td colspan="17">No entries found.</td></tr>` :
          rows.map(e=>`
            <tr>
              <td style="font-family:var(--mono);">${e.date}</td>
              <td>${nameOf(DB.shifts,e.shiftId)}</td>
              <td>${nameOf(DB.sites,e.siteId)}</td>
              <td>${nameOf(DB.locations,e.locationId)}</td>
              <td style="font-family:var(--mono);">${(byId(DB.machines,e.machineId)||{}).machineCode || '—'}</td>
              <td>${nameOf(DB.machines,e.machineId)}</td>
              <td style="font-family:var(--mono);">${(byId(DB.items,e.itemId)||{}).itemCode || '—'}</td>
              <td>${nameOf(DB.items,e.itemId)}</td>
              <td style="font-family:var(--mono);">${e.spm}</td>
              <td style="font-family:var(--mono);">${e.weight ? fmt1(e.weight) : '—'}</td>
              <td style="font-family:var(--mono);">${e.qty}</td>
              <td style="font-family:var(--mono);">${e.rejectedQty||0}</td>
              <td style="font-family:var(--mono);">${e.downtimeMinutes||0}</td>
              <td>${downtimeSummaryHtml(e)}</td>
              <td>${e.operatorName}</td>
              <td>${e.supervisorName||nameOf(DB.users,e.supervisorId)}${e.lastEditedByName ? `<div style="font-size:11px;color:var(--ink-dim);margin-top:2px;">edited by ${e.lastEditedByName}</div>` : ''}</td>
              <td>
                ${canManage(e) ? `
                <div class="row-actions">
                  <button class="icon-btn" data-edit="${e.id}" title="Edit">✎</button>
                  <button class="icon-btn danger" data-del="${e.id}" title="Delete">✕</button>
                </div>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>
  `;
}

function attachEntryLogEvents(){
  const s = document.getElementById('lf_start'), e = document.getElementById('lf_end');
  const m = document.getElementById('lf_machine'), sh = document.getElementById('lf_shift'), st = document.getElementById('lf_site');
  const search = document.getElementById('lf_search');
  s.onchange = ()=>{ logFilters.start = s.value; render(); };
  e.onchange = ()=>{ logFilters.end = e.value; render(); };
  m.onchange = ()=>{ logFilters.machineId = m.value; render(); };
  sh.onchange = ()=>{ logFilters.shiftId = sh.value; render(); };
  st.onchange = ()=>{ logFilters.siteId = st.value; render(); };
  search.oninput = ()=>{
    const pos = search.selectionStart;
    logFilters.search = search.value;
    render();
    const fresh = document.getElementById('lf_search');
    if(fresh){ fresh.focus(); fresh.setSelectionRange(pos,pos); }
  };
  document.getElementById('lf_clear').onclick = ()=>{ logFilters = {start:'',end:'',machineId:'',shiftId:'',siteId:'',search:''}; render(); };

  document.querySelectorAll('[data-edit]').forEach(btn=>{
    btn.onclick = ()=>{
      const rec = DB.entries.find(x=>x.id===btn.dataset.edit);
      if(!rec) return;
      entryDraft = {...rec};
      if(!entryDraft.downtimeBlocks || entryDraft.downtimeBlocks.length===0){
        entryDraft.downtimeBlocks = (Number(entryDraft.downtimeMinutes)>0)
          ? [{id:uid('dtb'), reasonId: entryDraft.downtimeReasonId||'', from:'', to:'', minutes: Number(entryDraft.downtimeMinutes)}]
          : [];
      }
      editingEntryId = rec.id;
      ROUTE='newentry'; render();
    };
  });
  document.querySelectorAll('[data-del]').forEach(btn=>{
    btn.onclick = async ()=>{
      if(!confirm('Delete this entry? This cannot be undone.')) return;
      DB.entries = DB.entries.filter(x=>x.id!==btn.dataset.del);
      await save('entries');
      render();
    };
  });
}

/* ================= MASTER DATA ================= */
let mdTab = 'machines';
let mdSearch = '';
let mdEditingId = null;
const MD_TABS = [
  {key:'machines', label:'Machines'},
  {key:'items', label:'Items'},
  {key:'spm', label:'SPM'},
  {key:'locations', label:'Locations'},
  {key:'sites', label:'Sites'},
  {key:'shifts', label:'Shifts'},
  {key:'reasons', label:'Down Time Reasons'},
  {key:'users', label:'Supervisor Accounts'},
];

function pageMasterData(){
  return `
  <div class="page-head">
    <div>
      <div class="page-eyebrow">Configuration</div>
      <div class="page-title">Master Data</div>
    </div>
  </div>
  <div class="panel">
    <div class="tabs">
      ${MD_TABS.map(t=>`<button class="tab-btn ${mdTab===t.key?'active':''}" data-tab="${t.key}">${t.label}</button>`).join('')}
    </div>
    <div id="mdBody">${renderMdTab()}</div>
  </div>
  <div class="panel" style="margin-top:18px; border-color:var(--red);">
    <div class="panel-title" style="color:var(--red);"><span class="bar" style="background:var(--red);"></span>Danger Zone</div>
    <p class="helptext" style="margin-bottom:14px;">Before going live, clear all test/UAT production entries while keeping every Master Data setup (machines, items, SPM, locations, sites, shifts, reasons, accounts) untouched. Entries will start fresh from zero. This cannot be undone.</p>
    <button class="btn btn-danger btn-sm" id="clearEntriesBtn" type="button">Clear All Entries (keep Master Data)</button>
  </div>
  `;
}

function renderMdTab(){
  if(mdTab==='machines') return simpleListEditor('machines', [{key:'name',label:'Machine Name'},{key:'machineCode',label:'Machine Code'},{key:'site',label:'Site',type:'select',options:DB.sites},{key:'location',label:'Location',type:'select',options:DB.locations}]);
  if(mdTab==='items') return weightFixBlock() + simpleListEditor('items', [{key:'name',label:'Item Name'},{key:'itemCode',label:'Item Code'},{key:'description',label:'Description'},{key:'weightPerPiece',label:'Weight/Pc (g)',type:'number'}]);
  if(mdTab==='locations') return simpleListEditor('locations', [{key:'name',label:'Location Name'}]);
  if(mdTab==='sites') return simpleListEditor('sites', [{key:'name',label:'Site Name'}]);
  if(mdTab==='shifts') return simpleListEditor('shifts', [{key:'name',label:'Shift Name'},{key:'startTime',label:'Start Time',type:'time'},{key:'durationMinutes',label:'Duration (min)',type:'number'},{key:'breakMinutes',label:'Break (min)',type:'number'}]);
  if(mdTab==='reasons') return simpleListEditor('reasons', [{key:'name',label:'Reason'}]);
  if(mdTab==='spm') return spmEditor();
  if(mdTab==='users') return usersEditor();
  return '';
}

/* ---------------- CSV import ---------------- */
function parseCsv(text){
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length>0);
  if(lines.length===0) return [];
  const parseLine = (line)=>{
    const result = []; let cur=''; let inQuotes=false;
    for(let i=0;i<line.length;i++){
      const ch = line[i];
      if(inQuotes){
        if(ch === '"'){ if(line[i+1] === '"'){ cur+='"'; i++; } else { inQuotes=false; } }
        else { cur+=ch; }
      } else {
        if(ch === '"'){ inQuotes = true; }
        else if(ch === ','){ result.push(cur); cur=''; }
        else { cur+=ch; }
      }
    }
    result.push(cur);
    return result.map(s=>s.trim());
  };
  const headers = parseLine(lines[0]).map(h=>h.toLowerCase());
  return lines.slice(1).map(line=>{
    const vals = parseLine(line);
    const obj = {};
    headers.forEach((h,idx)=>{ obj[h] = vals[idx] !== undefined ? vals[idx] : ''; });
    return obj;
  });
}

function csvImportBlock(dbKey, fields){
  const headerRow = fields.map(f=>f.key.toLowerCase()).join(',');
  const sampleRow = fields.map(f=>{
    if(f.type==='select') return f.options[0] ? f.options[0].name : 'Site A';
    if(f.key==='durationMinutes') return '480';
    return 'Example Name';
  }).join(',');
  const csvTemplate = headerRow + '\n' + sampleRow;
  const dataUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvTemplate);
  return `
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px; flex-wrap:wrap; padding:12px; border:1px dashed var(--line); border-radius:4px;">
    <label class="btn btn-ghost btn-sm" style="cursor:pointer; margin:0;">
      Import CSV
      <input type="file" accept=".csv" id="csvImport_${dbKey}" style="display:none;">
    </label>
    <a href="${dataUri}" download="${dbKey}_template.csv" class="link-btn">Download template (columns: ${headerRow})</a>
  </div>`;
}

function wireCsvImport(dbKey, fields){
  const input = document.getElementById('csvImport_'+dbKey);
  if(!input) return;
  input.onchange = async (ev)=>{
    const file = ev.target.files[0];
    if(!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    let added=0, updated=0, skippedBad=0;
    rows.forEach(row=>{
      const draft = {};
      let bad = false;
      fields.forEach(f=>{
        const val = row[f.key.toLowerCase()];
        if(f.type==='select'){
          const match = f.options.find(o=>o.name.toLowerCase() === String(val||'').trim().toLowerCase());
          if(!match){ bad = true; return; }
          draft[f.key] = match.id;
        } else if(f.type==='number'){
          draft[f.key] = Number(val)||0;
        } else {
          draft[f.key] = (val||'').trim();
        }
      });
      if(bad || !draft.name){ skippedBad++; return; }
      const existing = DB[dbKey].find(x=>x.name && x.name.toLowerCase()===draft.name.toLowerCase());
      if(existing){
        Object.assign(existing, draft); // update fields on the matched record, keep its id
        updated++;
      } else {
        DB[dbKey].push({id: uid(dbKey.slice(0,3)), ...draft});
        added++;
      }
    });
    if(added>0 || updated>0) await save(dbKey);
    alert(`Import finished: ${added} added, ${updated} updated (matched by name), ${skippedBad} skipped (missing name or unmatched reference).`);
    input.value = '';
    render();
  };
}

function wireSpmCsvImport(){
  const input = document.getElementById('csvImport_spm');
  if(!input) return;
  input.onchange = async (ev)=>{
    const file = ev.target.files[0];
    if(!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    let added=0, updated=0, skipped=0;
    rows.forEach(row=>{
      const mCode = (row['machinecode']||'').trim();
      const iCode = (row['itemcode']||'').trim();
      const spmVal = Number(row['spm']);
      const machine = DB.machines.find(m=>(m.machineCode||'').toLowerCase()===mCode.toLowerCase() && mCode!=='');
      const item = DB.items.find(m=>(m.itemCode||'').toLowerCase()===iCode.toLowerCase() && iCode!=='');
      if(!machine || !item || !spmVal){ skipped++; return; }
      const existing = DB.spm.find(s=>s.machineId===machine.id && s.itemId===item.id);
      if(existing){ existing.spm = spmVal; updated++; }
      else { DB.spm.push({id:uid('spm'), machineId:machine.id, itemId:item.id, spm:spmVal}); added++; }
    });
    if(added>0 || updated>0) await save('spm');
    alert(`SPM import finished: ${added} added, ${updated} updated, ${skipped} skipped (machine code/item code not found, or invalid SPM value).`);
    input.value = '';
    render();
  };
}

function wireUsersCsvImport(){
  const input = document.getElementById('csvImport_users');
  if(!input) return;
  input.onchange = async (ev)=>{
    const file = ev.target.files[0];
    if(!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    let added=0, updated=0, skipped=0;
    for(const row of rows){
      const id = (row['userid']||'').trim();
      const name = (row['fullname']||'').trim();
      let role = (row['role']||'').trim().toLowerCase();
      if(!['operator','supervisor','admin'].includes(role)) role = '';
      const locName = (row['location']||'').trim();
      const location = locName ? DB.locations.find(l=>l.name.toLowerCase()===locName.toLowerCase()) : null;
      const password = row['password']||'';
      const secQ = (row['securityquestion']||'').trim();
      const secA = (row['securityanswer']||'').trim();
      if(!id || !name || !role){ skipped++; continue; }
      const existing = DB.users.find(u=>u.id.toLowerCase()===id.toLowerCase());
      if(existing){
        existing.name = name;
        existing.role = role;
        if(locName){ existing.locationId = location ? location.id : existing.locationId; }
        else { existing.locationId = ''; }
        if(password) existing.passwordHash = await sha256(password);
        if(secQ){ existing.securityQ = secQ; if(secA) existing.securityAHash = await sha256(secA.toLowerCase()); }
        updated++;
      } else {
        if(!password){ skipped++; continue; }
        const passwordHash = await sha256(password);
        const securityAHash = secA ? await sha256(secA.toLowerCase()) : await sha256('not set');
        DB.users.push({
          id, name, role, locationId: location ? location.id : '',
          passwordHash, securityQ: secQ || 'What is your favorite tool?', securityAHash
        });
        added++;
      }
    }
    if(added>0 || updated>0) await save('users');
    alert(`Account import finished: ${added} added, ${updated} updated (matched by User ID), ${skipped} skipped (missing User ID, Full Name, valid Role, or — for new accounts — a Password).`);
    input.value = '';
    render();
  };
}

function exportUsersCsv(){
  const header = ['UserID','FullName','Role','Location','SecurityQuestion'];
  const lines = [header.join(',')];
  DB.users.forEach(u=>{
    lines.push([
      u.id, u.name, u.role, u.locationId ? nameOf(DB.locations,u.locationId) : 'All', u.securityQ||''
    ].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
  });
  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `prf-accounts-${todayStr()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function weightFixBlock(){
  const affected = DB.items.filter(i=>Number(i.weightPerPiece)>0 && Number(i.weightPerPiece)<1);
  if(affected.length===0) return '';
  return `
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px; flex-wrap:wrap; padding:12px; border:1px dashed var(--amber-dim); border-radius:4px; background:rgba(245,166,35,0.05);">
    <div style="flex:1; min-width:240px; font-size:12.5px; color:var(--ink-dim);">
      <b style="color:var(--amber);">${affected.length} item${affected.length===1?'':'s'}</b> have a Weight/Pc under 1 gram — almost certainly a kg value typed into the grams field by mistake (e.g. 0.02 instead of 20).
    </div>
    <button class="btn btn-ghost btn-sm" id="fixWeightUnitsBtn" type="button">Review &amp; Fix (×1000)</button>
  </div>`;
}
function weightFixModal(){
  const affected = DB.items.filter(i=>Number(i.weightPerPiece)>0 && Number(i.weightPerPiece)<1);
  const rows = affected.map(i=>`
    <tr>
      <td>${i.name}</td>
      <td style="font-family:var(--mono);">${i.weightPerPiece}</td>
      <td style="font-family:var(--mono); color:var(--green);">${Math.round(Number(i.weightPerPiece)*1000*100)/100}</td>
    </tr>`).join('');
  return `
    <div class="modal-title">Fix Weight/Pc Units</div>
    <p class="helptext" style="margin-bottom:14px;">This multiplies the Weight/Pc of the ${affected.length} item(s) below by 1000 — turning kg values that were mistakenly typed into the grams field into correct gram values. Every entry using these items will recalculate automatically once saved; nothing else changes.</p>
    <div class="table-scroll" style="max-height:280px; overflow-y:auto; margin-bottom:16px;">
      <table>
        <thead><tr><th>Item</th><th>Current</th><th>Corrected</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <form id="weightFixForm">
      <div class="form-actions">
        <button class="btn" type="submit">Apply ×1000 to These ${affected.length} Items</button>
        <button class="btn btn-ghost" type="button" id="cancelWeightFixModal">Cancel</button>
      </div>
    </form>`;
}
function attachWeightFixModalEvents(){
  document.getElementById('cancelWeightFixModal').onclick = closeModal;
  document.getElementById('weightFixForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    const affected = DB.items.filter(i=>Number(i.weightPerPiece)>0 && Number(i.weightPerPiece)<1);
    affected.forEach(i=>{ i.weightPerPiece = Math.round(Number(i.weightPerPiece)*1000*100)/100; });
    const ok = await save('items');
    closeModal();
    render();
    alert(ok ? `Fixed ${affected.length} item(s). Weight totals will now recalculate correctly across the app.` : 'Warning: fix applied locally but may not have synced. Please check your connection and try again.');
  };
}

function simpleListEditor(dbKey, fields){
  let list = DB[dbKey];
  if(mdSearch.trim()){
    const q = mdSearch.trim().toLowerCase();
    list = list.filter(item=>{
      const haystack = fields.map(f=> f.type==='select' ? nameOf(f.options, item[f.key]) : (item[f.key]!==undefined?item[f.key]:'')).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }
  const editingRecord = mdEditingId ? DB[dbKey].find(x=>x.id===mdEditingId) : null;
  const inputs = fields.map(f=>{
    const curVal = editingRecord ? editingRecord[f.key] : '';
    if(f.type==='select'){
      return `<div class="field"><label>${f.label}</label><select id="md_${f.key}">${f.options.map(o=>`<option value="${o.id}" ${editingRecord && o.id===curVal ? 'selected':''}>${o.name}</option>`).join('')}</select></div>`;
    }
    return `<div class="field"><label>${f.label}</label><input type="${f.type||'text'}" id="md_${f.key}" value="${curVal!==undefined&&curVal!==null?curVal:''}"></div>`;
  }).join('');
  return `
  ${csvImportBlock(dbKey, fields)}
  <div style="display:flex; align-items:flex-end; gap:16px; margin-bottom:16px; flex-wrap:wrap;">
    <div class="field" style="max-width:320px; margin-bottom:0;"><label>Search</label><input type="text" id="mdSearchInput" placeholder="Search ${MD_TABS.find(t=>t.key===mdTab).label.toLowerCase()}..." value="${mdSearch}"></div>
    ${DB[dbKey].length>0 ? `<button class="btn btn-ghost btn-sm" id="clearListBtn" data-clearlist="${dbKey}" type="button" style="color:var(--red); border-color:var(--red);">Clear All ${MD_TABS.find(t=>t.key===mdTab).label}</button>` : ''}
  </div>
  <form class="mini-form" id="mdAddForm">
    ${inputs}
    <button class="btn btn-sm" type="submit">${editingRecord ? 'Update' : 'Add'}</button>
    ${editingRecord ? `<button class="btn btn-ghost btn-sm" type="button" id="mdCancelEdit">Cancel</button>` : ''}
  </form>
  <div class="table-scroll">
    <table>
      <thead><tr>${fields.map(f=>`<th>${f.label}</th>`).join('')}<th></th></tr></thead>
      <tbody>
      ${list.length===0 ? `<tr class="empty-row"><td colspan="${fields.length+1}">${mdSearch.trim() ? 'No matches found.' : 'No records yet.'}</td></tr>` :
        list.map(item=>`
          <tr ${mdEditingId===item.id ? 'style="background:rgba(245,166,35,0.06);"' : ''}>
            ${fields.map(f=> f.type==='select' ? `<td>${nameOf(f.options, item[f.key])}</td>` : `<td>${(item[f.key]!==undefined && item[f.key]!==null && item[f.key]!=='') ? item[f.key] : '—'}</td>`).join('')}
            <td>
              <div class="row-actions">
                <button class="icon-btn" data-mdedit="${dbKey}:${item.id}" title="Edit">✎</button>
                <button class="icon-btn danger" data-mddel="${dbKey}:${item.id}" title="Delete">✕</button>
              </div>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>
  `;
}

function spmEditor(){
  const sampleMachineCode = DB.machines[0] && DB.machines[0].machineCode ? DB.machines[0].machineCode : 'M-01';
  const sampleItemCode = DB.items[0] && DB.items[0].itemCode ? DB.items[0].itemCode : 'IT-01';
  const csvTemplate = 'machinecode,itemcode,spm\n' + sampleMachineCode + ',' + sampleItemCode + ',12';
  const dataUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvTemplate);
  let list = DB.spm;
  if(mdSearch.trim()){
    const q = mdSearch.trim().toLowerCase();
    list = list.filter(s=> (machineCodeOf(s.machineId)+' '+itemCodeOf(s.itemId)+' '+s.spm).toLowerCase().includes(q));
  }
  return `
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px; flex-wrap:wrap; padding:12px; border:1px dashed var(--line); border-radius:4px;">
    <label class="btn btn-ghost btn-sm" style="cursor:pointer; margin:0;">
      Import CSV
      <input type="file" accept=".csv" id="csvImport_spm" style="display:none;">
    </label>
    <a href="${dataUri}" download="spm_template.csv" class="link-btn">Download template (columns: machinecode,itemcode,spm — machine &amp; item must already exist with these codes set)</a>
  </div>
  <div style="display:flex; align-items:flex-end; gap:16px; margin-bottom:16px; flex-wrap:wrap;">
    <div class="field" style="max-width:320px; margin-bottom:0;"><label>Search</label><input type="text" id="mdSearchInput" placeholder="Search by machine or item code..." value="${mdSearch}"></div>
    ${DB.spm.length>0 ? `<button class="btn btn-ghost btn-sm" id="clearListBtn" data-clearlist="spm" type="button" style="color:var(--red); border-color:var(--red);">Clear All SPM</button>` : ''}
  </div>
  <form class="mini-form" id="spmAddForm">
    <div class="field"><label>Machine</label><select id="spm_machine">${renderMachineOptions(DB.machines, '', 'Select machine')}</select></div>
    <div class="field"><label>Item</label><select id="spm_item">${renderItemOptions(DB.items, '', 'Select item')}</select></div>
    <div class="field"><label>SPM</label><input type="number" min="0" id="spm_value" required></div>
    <button class="btn btn-sm" type="submit">Add / Update</button>
  </form>
  <div class="table-scroll">
    <table>
      <thead><tr><th>Machine Code</th><th>Item Code</th><th>SPM</th><th></th></tr></thead>
      <tbody>
      ${list.length===0 ? `<tr class="empty-row"><td colspan="4">${mdSearch.trim() ? 'No matches found.' : 'No SPM records yet.'}</td></tr>` :
        list.map(s=>`
          <tr>
            <td>${machineCodeOf(s.machineId)}</td>
            <td>${itemCodeOf(s.itemId)}</td>
            <td style="font-family:var(--mono);">${s.spm}</td>
            <td><button class="icon-btn danger" data-mddel="spm:${s.id}" title="Delete">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>
  `;
}

function usersEditor(){
  let list = DB.users;
  if(mdSearch.trim()){
    const q = mdSearch.trim().toLowerCase();
    list = list.filter(u=> (u.id+' '+u.name+' '+u.role).toLowerCase().includes(q));
  }
  const csvTemplate = 'userid,fullname,role,location,password,securityquestion,securityanswer\nop01,Ramesh Kumar,operator,' + (DB.locations[0]?DB.locations[0].name:'PRF-I') + ',Temp@123,What is your favorite tool?,Hammer';
  const dataUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvTemplate);
  return `
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px; flex-wrap:wrap; padding:12px; border:1px dashed var(--line); border-radius:4px;">
    <label class="btn btn-ghost btn-sm" style="cursor:pointer; margin:0;">
      Import CSV
      <input type="file" accept=".csv" id="csvImport_users" style="display:none;">
    </label>
    <a href="${dataUri}" download="accounts_template.csv" class="link-btn">Download template (columns: userid,fullname,role,location,password,securityquestion,securityanswer — role must be operator/supervisor/admin, location must match an existing Location name, leave blank for all locations)</a>
  </div>
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px; flex-wrap:wrap;">
    <button class="btn btn-sm" id="addUserBtn" type="button">+ Add Supervisor Account</button>
    <button class="btn btn-ghost btn-sm" id="exportUsersBtn" type="button">Export Accounts Report (CSV)</button>
  </div>
  <div class="field" style="max-width:320px; margin-bottom:16px;"><label>Search</label><input type="text" id="mdSearchInput" placeholder="Search by ID or name..." value="${mdSearch}"></div>
  <div class="table-scroll">
    <table>
      <thead><tr><th>User ID</th><th>Name</th><th>Role</th><th>Location</th><th></th></tr></thead>
      <tbody>
      ${list.length===0 ? `<tr class="empty-row"><td colspan="5">${mdSearch.trim() ? 'No matches found.' : 'No accounts yet.'}</td></tr>` :
        list.map(u=>`
        <tr>
          <td style="font-family:var(--mono);">${u.id}</td>
          <td>${u.name}</td>
          <td><span class="tag ${u.role==='admin'?'tag-role-admin':u.role==='operator'?'tag-role-operator':u.role==='head'?'tag-role-head':''}">${u.role}</span></td>
          <td>${u.locationId ? nameOf(DB.locations,u.locationId) : '<span style="color:var(--ink-dim);">All</span>'}</td>
          <td>
            <div class="row-actions">
              <button class="icon-btn" data-assignloc="${u.id}" title="Assign Location">📍</button>
              <button class="icon-btn" data-changerole="${u.id}" title="Change Role">⇄</button>
              <button class="icon-btn" data-resetpw="${u.id}" title="Reset Password">⟲</button>
              ${u.id!==SESSION.id ? `<button class="icon-btn danger" data-deluser="${u.id}" title="Delete">✕</button>` : ''}
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
  `;
}

function attachMasterDataEvents(){
  document.querySelectorAll('[data-tab]').forEach(btn=>{
    btn.onclick = ()=>{ mdTab = btn.dataset.tab; mdSearch = ''; mdEditingId = null; render(); };
  });

  const mdSearchInput = document.getElementById('mdSearchInput');
  if(mdSearchInput) mdSearchInput.oninput = ()=>{
    const pos = mdSearchInput.selectionStart;
    mdSearch = mdSearchInput.value;
    render();
    const fresh = document.getElementById('mdSearchInput');
    if(fresh){ fresh.focus(); fresh.setSelectionRange(pos,pos); }
  };

  const fieldsMap = {
    machines:[{key:'name',label:'Machine Name'},{key:'machineCode',label:'Machine Code'},{key:'site',label:'Site',type:'select',options:DB.sites},{key:'location',label:'Location',type:'select',options:DB.locations}],
    items:[{key:'name',label:'Item Name'},{key:'itemCode',label:'Item Code'},{key:'description',label:'Description'},{key:'weightPerPiece',label:'Weight/Pc (g)',type:'number'}],
    locations:[{key:'name',label:'Location Name'}],
    sites:[{key:'name',label:'Site Name'}],
    shifts:[{key:'name',label:'Shift Name'},{key:'startTime',label:'Start Time',type:'time'},{key:'durationMinutes',label:'Duration (min)',type:'number'},{key:'breakMinutes',label:'Break (min)',type:'number'}],
    reasons:[{key:'name',label:'Reason'}]
  };
  if(fieldsMap[mdTab]) wireCsvImport(mdTab, fieldsMap[mdTab]);
  if(mdTab==='spm') wireSpmCsvImport();
  if(mdTab==='users') wireUsersCsvImport();

  const addForm = document.getElementById('mdAddForm');
  if(addForm) addForm.onsubmit = async (ev)=>{
    ev.preventDefault();
    const fields = fieldsMap[mdTab];
    const draft = {};
    fields.forEach(f=>{
      const el = document.getElementById('md_'+f.key);
      draft[f.key] = f.type==='number' ? Number(el.value)||0 : el.value;
    });
    if(!draft.name){ alert('Name required'); return; }
    if(mdEditingId){
      const existing = DB[mdTab].find(x=>x.id===mdEditingId);
      if(existing) Object.assign(existing, draft);
      mdEditingId = null;
    } else {
      DB[mdTab].push({id: uid(mdTab.slice(0,3)), ...draft});
    }
    await save(mdTab);
    render();
  };
  const mdCancelEdit = document.getElementById('mdCancelEdit');
  if(mdCancelEdit) mdCancelEdit.onclick = ()=>{ mdEditingId = null; render(); };
  document.querySelectorAll('[data-mdedit]').forEach(btn=>{
    btn.onclick = ()=>{
      const [key, id] = btn.dataset.mdedit.split(':');
      mdEditingId = id;
      render();
    };
  });

  const spmForm = document.getElementById('spmAddForm');
  if(spmForm) spmForm.onsubmit = async (ev)=>{
    ev.preventDefault();
    const machineId = document.getElementById('spm_machine').value;
    const itemId = document.getElementById('spm_item').value;
    const spmVal = Number(document.getElementById('spm_value').value);
    const existing = DB.spm.find(s=>s.machineId===machineId && s.itemId===itemId);
    if(existing){ existing.spm = spmVal; } else { DB.spm.push({id:uid('spm'), machineId, itemId, spm:spmVal}); }
    await save('spm');
    render();
  };

  document.querySelectorAll('[data-mddel]').forEach(btn=>{
    btn.onclick = async ()=>{
      const [key, id] = btn.dataset.mddel.split(':');
      if(!confirm('Delete this record?')) return;
      DB[key] = DB[key].filter(x=>x.id!==id);
      await save(key);
      render();
    };
  });

  const addUserBtn = document.getElementById('addUserBtn');
  if(addUserBtn) addUserBtn.onclick = ()=>{ showModal(userModal()); attachUserModalEvents(); };
  const exportUsersBtn = document.getElementById('exportUsersBtn');
  if(exportUsersBtn) exportUsersBtn.onclick = exportUsersCsv;

  const clearEntriesBtn = document.getElementById('clearEntriesBtn');
  if(clearEntriesBtn) clearEntriesBtn.onclick = ()=>{ showModal(clearEntriesModal()); attachClearEntriesModalEvents(); };

  const fixWeightUnitsBtn = document.getElementById('fixWeightUnitsBtn');
  if(fixWeightUnitsBtn) fixWeightUnitsBtn.onclick = ()=>{ showModal(weightFixModal()); attachWeightFixModalEvents(); };

  const clearListBtn = document.getElementById('clearListBtn');
  if(clearListBtn) clearListBtn.onclick = ()=>{
    const dbKey = clearListBtn.dataset.clearlist;
    const label = dbKey==='spm' ? 'SPM' : MD_TABS.find(t=>t.key===dbKey).label;
    showModal(clearListModal(dbKey, label));
    attachClearListModalEvents(dbKey, label);
  };

  document.querySelectorAll('[data-resetpw]').forEach(btn=>{
    btn.onclick = ()=>{ showModal(resetPwModal(btn.dataset.resetpw)); attachResetPwModalEvents(btn.dataset.resetpw); };
  });
  document.querySelectorAll('[data-changerole]').forEach(btn=>{
    btn.onclick = ()=>{ showModal(changeRoleModal(btn.dataset.changerole)); attachChangeRoleModalEvents(btn.dataset.changerole); };
  });
  document.querySelectorAll('[data-assignloc]').forEach(btn=>{
    btn.onclick = ()=>{ showModal(assignLocationModal(btn.dataset.assignloc)); attachAssignLocationModalEvents(btn.dataset.assignloc); };
  });
  document.querySelectorAll('[data-deluser]').forEach(btn=>{
    btn.onclick = async ()=>{
      if(!confirm('Delete this account?')) return;
      DB.users = DB.users.filter(u=>u.id!==btn.dataset.deluser);
      await save('users');
      render();
    };
  });
}

/* ---- modal ---- */
function showModal(html){
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.id = 'modalOverlay';
  wrap.innerHTML = `<div class="modal">${html}</div>`;
  wrap.onclick = (e)=>{ if(e.target===wrap) closeModal(); };
  document.body.appendChild(wrap);
}
function closeModal(){ const el = document.getElementById('modalOverlay'); if(el) el.remove(); }

function userModal(){
  const presetQuestions = [
    "What is your favorite tool?",
    "What was the name of your first machine you operated?",
    "What is your mother's maiden name?",
    "What was the name of your first pet?",
    "What city were you born in?",
    "What is your favorite color?",
    "What was your childhood nickname?"
  ];
  return `
    <div class="modal-title">Add Supervisor Account</div>
    <form id="addUserForm">
      <div class="field"><label>User ID</label><input type="text" id="nu_id" required></div>
      <div class="field"><label>Full Name</label><input type="text" id="nu_name" required></div>
      <div class="field"><label>Role</label><select id="nu_role"><option value="operator">Operator</option><option value="supervisor">Supervisor</option><option value="head">Department Head</option><option value="admin">Admin</option></select>
        <div class="helptext">Operator: submit entries only. Supervisor: full edit/delete on any entry. Department Head: Supervisor rights + Reports + all locations, but no Master Data. Admin: full access.</div>
      </div>
      <div class="field"><label>Assigned Location</label>
        <select id="nu_location">
          <option value="">All Locations (no restriction)</option>
          ${DB.locations.map(l=>`<option value="${l.id}">${l.name}</option>`).join('')}
        </select>
        <div class="helptext">If set, this person only sees and submits entries for that one location — locked on New Entry, filtered in Entry Log and Dashboard.</div>
      </div>
      <div class="field"><label>Password</label><input type="password" id="nu_pw" required minlength="4"></div>
      <div class="field"><label>Security Question</label>
        <select id="nu_sq_select">
          <option value="">Select a security question</option>
          ${presetQuestions.map(q=>`<option value="${q}">${q}</option>`).join('')}
          <option value="__custom__">Other (write my own)</option>
        </select>
      </div>
      <div class="field" id="nu_sq_custom_wrap" style="display:none;">
        <label>Custom Security Question</label>
        <input type="text" id="nu_sq_custom" placeholder="Type your own question">
      </div>
      <div class="field"><label>Security Answer</label><input type="text" id="nu_sa" required></div>
      <div class="form-actions">
        <button class="btn" type="submit">Create Account</button>
        <button class="btn btn-ghost" type="button" id="cancelModal">Cancel</button>
      </div>
    </form>`;
}
function attachUserModalEvents(){
  document.getElementById('cancelModal').onclick = closeModal;
  const sqSelect = document.getElementById('nu_sq_select');
  const sqCustomWrap = document.getElementById('nu_sq_custom_wrap');
  const sqCustomInput = document.getElementById('nu_sq_custom');
  sqSelect.onchange = ()=>{
    const isCustom = sqSelect.value === '__custom__';
    sqCustomWrap.style.display = isCustom ? '' : 'none';
    if(isCustom) sqCustomInput.focus();
  };
  document.getElementById('addUserForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    const id = document.getElementById('nu_id').value.trim();
    if(DB.users.find(u=>u.id.toLowerCase()===id.toLowerCase())){ alert('User ID already exists.'); return; }
    const selectedQ = sqSelect.value;
    const securityQ = selectedQ === '__custom__' ? sqCustomInput.value.trim() : selectedQ;
    if(!securityQ){ alert('Please select or write a security question.'); return; }
    const passwordHash = await sha256(document.getElementById('nu_pw').value);
    const securityAHash = await sha256(document.getElementById('nu_sa').value.trim().toLowerCase());
    DB.users.push({
      id, name: document.getElementById('nu_name').value.trim(),
      role: document.getElementById('nu_role').value,
      locationId: document.getElementById('nu_location').value,
      passwordHash, securityQ, securityAHash
    });
    await save('users');
    closeModal(); render();
  };
}

function resetPwModal(userId){
  return `
    <div class="modal-title">Reset Password</div>
    <p class="helptext" style="margin-bottom:14px;">Set a new temporary password for <b style="color:var(--ink);">${userId}</b>. Share it with them securely.</p>
    <form id="resetPwForm">
      <div class="field"><label>New Password</label><input type="password" id="rp_pw" required minlength="4"></div>
      <div class="form-actions">
        <button class="btn" type="submit">Set Password</button>
        <button class="btn btn-ghost" type="button" id="cancelModal2">Cancel</button>
      </div>
    </form>`;
}
function attachResetPwModalEvents(userId){
  document.getElementById('cancelModal2').onclick = closeModal;
  document.getElementById('resetPwForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    const user = DB.users.find(u=>u.id===userId);
    user.passwordHash = await sha256(document.getElementById('rp_pw').value);
    await save('users');
    closeModal(); render();
    alert('Password updated for ' + userId);
  };
}

function changeRoleModal(userId){
  const user = DB.users.find(u=>u.id===userId);
  const roles = [
    {key:'operator', label:'Operator — can submit entries only, cannot edit/delete'},
    {key:'supervisor', label:'Supervisor — full edit/delete on any entry'},
    {key:'head', label:'Department Head — Supervisor rights + Reports + all locations, no Master Data'},
    {key:'admin', label:'Admin — full access including Master Data & Reports'}
  ];
  return `
    <div class="modal-title">Change Role</div>
    <p class="helptext" style="margin-bottom:14px;">Update the role for <b style="color:var(--ink);">${userId}</b> (${user.name}). Current role: <b style="color:var(--amber);">${user.role}</b>.</p>
    <form id="changeRoleForm">
      <div class="field"><label>New Role</label>
        <select id="cr_role">
          ${roles.map(r=>`<option value="${r.key}" ${r.key===user.role?'selected':''}>${r.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">Update Role</button>
        <button class="btn btn-ghost" type="button" id="cancelModal3">Cancel</button>
      </div>
    </form>`;
}
function attachChangeRoleModalEvents(userId){
  document.getElementById('cancelModal3').onclick = closeModal;
  document.getElementById('changeRoleForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    const newRole = document.getElementById('cr_role').value;
    const user = DB.users.find(u=>u.id===userId);
    if(userId === SESSION.id && newRole !== 'admin' && user.role === 'admin'){
      const confirmed = confirm('You are changing your OWN role away from Admin. You will immediately lose access to Master Data and Reports, and this cannot be undone by yourself. Continue?');
      if(!confirmed) return;
    }
    user.role = newRole;
    await save('users');
    closeModal();
    if(userId === SESSION.id){ SESSION.role = newRole; }
    render();
    alert('Role updated for ' + userId + ' to ' + newRole + '.');
  };
}

function assignLocationModal(userId){
  const user = DB.users.find(u=>u.id===userId);
  return `
    <div class="modal-title">Assign Location</div>
    <p class="helptext" style="margin-bottom:14px;">Restrict <b style="color:var(--ink);">${userId}</b> (${user.name}) to one location. New Entry will lock to it, and Entry Log &amp; Dashboard will only show that location's records. Choose "All Locations" to remove the restriction — this can be changed anytime, e.g. when someone transfers between plants.</p>
    <form id="assignLocForm">
      <div class="field"><label>Location</label>
        <select id="al_location">
          <option value="">All Locations (no restriction)</option>
          ${DB.locations.map(l=>`<option value="${l.id}" ${l.id===user.locationId?'selected':''}>${l.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">Save</button>
        <button class="btn btn-ghost" type="button" id="cancelModal4">Cancel</button>
      </div>
    </form>`;
}
function attachAssignLocationModalEvents(userId){
  document.getElementById('cancelModal4').onclick = closeModal;
  document.getElementById('assignLocForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    const newLoc = document.getElementById('al_location').value;
    const user = DB.users.find(u=>u.id===userId);
    user.locationId = newLoc;
    await save('users');
    closeModal();
    if(userId === SESSION.id){ SESSION.locationId = newLoc; }
    render();
    alert('Location updated for ' + userId + '.');
  };
}

function clearEntriesModal(){
  return `
    <div class="modal-title" style="color:var(--red);">Clear All Entries</div>
    <p class="helptext" style="margin-bottom:14px;">
      This permanently deletes all ${DB.entries.length} production entries from the shared database.
      Master Data (machines, items, SPM, locations, sites, shifts, reasons, accounts) will NOT be touched.
      This cannot be undone.
    </p>
    <form id="clearEntriesForm">
      <div class="field"><label>Type DELETE ENTRIES to confirm</label><input type="text" id="clear_confirm" autocomplete="off" required></div>
      <div class="form-actions">
        <button class="btn btn-danger" type="submit">Permanently Clear All Entries</button>
        <button class="btn btn-ghost" type="button" id="cancelClearModal">Cancel</button>
      </div>
    </form>`;
}
function attachClearEntriesModalEvents(){
  document.getElementById('cancelClearModal').onclick = closeModal;
  document.getElementById('clearEntriesForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    const typed = document.getElementById('clear_confirm').value.trim();
    if(typed !== 'DELETE ENTRIES'){ alert('Text did not match. Type exactly: DELETE ENTRIES'); return; }
    DB.entries = [];
    const ok = await save('entries');
    closeModal();
    ROUTE = 'masterdata';
    render();
    alert(ok ? 'All entries cleared. Master Data is untouched — ready for go-live.' : 'Warning: clear may not have synced to the shared database. Please check your connection and try again.');
  };
}

function clearListModal(dbKey, label){
  const count = DB[dbKey].length;
  const usedByEntries = ['machines','items','locations','sites','shifts','reasons'].includes(dbKey);
  return `
    <div class="modal-title" style="color:var(--red);">Clear All ${label}</div>
    <p class="helptext" style="margin-bottom:14px;">
      This permanently deletes all ${count} record(s) from ${label} so you can re-upload a fresh CSV.
      ${usedByEntries ? `Existing Entry Log records referencing a deleted ${label.slice(0,-1).toLowerCase()} will show "—" instead of its name (the entries themselves are not deleted).` : ''}
      This cannot be undone.
    </p>
    <form id="clearListForm">
      <div class="field"><label>Type DELETE ${label.toUpperCase()} to confirm</label><input type="text" id="clearlist_confirm" autocomplete="off" required></div>
      <div class="form-actions">
        <button class="btn btn-danger" type="submit">Permanently Clear ${label}</button>
        <button class="btn btn-ghost" type="button" id="cancelClearListModal">Cancel</button>
      </div>
    </form>`;
}
function attachClearListModalEvents(dbKey, label){
  document.getElementById('cancelClearListModal').onclick = closeModal;
  document.getElementById('clearListForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    const expected = 'DELETE ' + label.toUpperCase();
    const typed = document.getElementById('clearlist_confirm').value.trim();
    if(typed !== expected){ alert('Text did not match. Type exactly: ' + expected); return; }
    DB[dbKey] = [];
    const ok = await save(dbKey);
    closeModal();
    render();
    alert(ok ? `All ${label} cleared. You can now re-upload via CSV.` : 'Warning: clear may not have synced to the shared database. Please check your connection and try again.');
  };
}

/* ================= REPORTS ================= */
let repFilters = { start: monthStartStr(), end: todayStr(), machineId:'', siteId:'', shiftId:'' };

function pageReports(){
  let rows = DB.entries.slice();
  if(repFilters.start) rows = rows.filter(e=>e.date >= repFilters.start);
  if(repFilters.end) rows = rows.filter(e=>e.date <= repFilters.end);
  if(repFilters.machineId) rows = rows.filter(e=>e.machineId===repFilters.machineId);
  if(repFilters.siteId) rows = rows.filter(e=>e.siteId===repFilters.siteId);
  if(repFilters.shiftId) rows = rows.filter(e=>e.shiftId===repFilters.shiftId);
  const agg = aggregate(rows);

  const machineRows = buildMachineSummary(rows);

  return `
  <div class="page-head">
    <div>
      <div class="page-eyebrow">Analysis</div>
      <div class="page-title">Reports</div>
    </div>
    <button class="btn" id="exportCsv">Export CSV</button>
  </div>
  <div class="panel">
    <div class="filter-bar">
      <div class="field"><label>From</label><input type="date" id="rf_start" value="${repFilters.start}"></div>
      <div class="field"><label>To</label><input type="date" id="rf_end" value="${repFilters.end}"></div>
      <div class="field"><label>Machine</label><select id="rf_machine"><option value="">All</option>${DB.machines.map(m=>`<option value="${m.id}" ${repFilters.machineId===m.id?'selected':''}>${m.name}</option>`).join('')}</select></div>
      <div class="field"><label>Site</label><select id="rf_site"><option value="">All</option>${DB.sites.map(m=>`<option value="${m.id}" ${repFilters.siteId===m.id?'selected':''}>${m.name}</option>`).join('')}</select></div>
      <div class="field"><label>Shift</label><select id="rf_shift"><option value="">All</option>${DB.shifts.map(m=>`<option value="${m.id}" ${repFilters.shiftId===m.id?'selected':''}>${m.name}</option>`).join('')}</select></div>
    </div>

    <div class="grid-4" style="margin-bottom:20px;">
      <div class="kpi-card"><div class="kpi-label">OEE %</div><div class="kpi-value" style="color:${kpiColor(agg.oeePct)};font-size:20px;">${fmt1(agg.oeePct)}%</div></div>
      <div class="kpi-card"><div class="kpi-label">Down Time %</div><div class="kpi-value" style="font-size:20px;">${fmt1(agg.downtimePct)}%</div></div>
      <div class="kpi-card"><div class="kpi-label">Total Qty</div><div class="kpi-value" style="font-size:20px;">${agg.totalQty}</div></div>
      <div class="kpi-card"><div class="kpi-label">Total Weight (kg)</div><div class="kpi-value" style="font-size:20px;">${fmt1(agg.totalWeightKg)}</div></div>
    </div>

    <div class="panel-title" style="margin-bottom:10px;"><span class="bar"></span>Machine Performance Summary</div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Machine</th><th>Planned Qty</th><th>Actual Qty</th><th>Weight (kg)</th><th>OEE %</th><th>Losses (Reason: Minutes)</th></tr></thead>
        <tbody>
          ${machineRows.length===0 ? `<tr class="empty-row"><td colspan="6">No data in this range.</td></tr>` :
            machineRows.map(r=>`
              <tr>
                <td>${nameOf(DB.machines,r.mid)}</td>
                <td style="font-family:var(--mono);">${r.plannedQty}</td>
                <td style="font-family:var(--mono);">${r.actualQty}</td>
                <td style="font-family:var(--mono);">${r.weightKg}</td>
                <td style="font-family:var(--mono);color:${kpiColor(r.oeePct)};">${fmt1(r.oeePct)}%</td>
                <td style="font-size:12.5px;color:var(--ink-dim);">${r.lossText}</td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="helptext" style="margin-top:10px;">Planned Qty = SPM × full shift duration (before any losses). Actual Qty = what was actually produced. Weight = entered Weight where available, otherwise Qty × Item's Weight/Pc, shown in kg. Losses lists down time minutes grouped by reason, largest first.</div>
  </div>
  `;
}

function attachReportsEvents(){
  const s = document.getElementById('rf_start'), e = document.getElementById('rf_end');
  const m = document.getElementById('rf_machine'), st = document.getElementById('rf_site'), sh = document.getElementById('rf_shift');
  s.onchange = ()=>{ repFilters.start = s.value; render(); };
  e.onchange = ()=>{ repFilters.end = e.value; render(); };
  m.onchange = ()=>{ repFilters.machineId = m.value; render(); };
  st.onchange = ()=>{ repFilters.siteId = st.value; render(); };
  sh.onchange = ()=>{ repFilters.shiftId = sh.value; render(); };

  document.getElementById('exportCsv').onclick = ()=>{
    let rows = DB.entries.slice();
    if(repFilters.start) rows = rows.filter(x=>x.date >= repFilters.start);
    if(repFilters.end) rows = rows.filter(x=>x.date <= repFilters.end);
    if(repFilters.machineId) rows = rows.filter(x=>x.machineId===repFilters.machineId);
    if(repFilters.siteId) rows = rows.filter(x=>x.siteId===repFilters.siteId);
    if(repFilters.shiftId) rows = rows.filter(x=>x.shiftId===repFilters.shiftId);
    const header = ['Date','Shift','Site','Location','MachineCode','Machine','ItemCode','Item','ItemDescription','SPM','Weight','Qty','Rejected','DowntimeMin','Reason','Operator','Supervisor','LastEditedBy','LastEditedAt','OeePct','DowntimePct'];
    const lines = [header.join(',')];
    rows.forEach(r=>{
      const c = entryCalc(r);
      const itemRec = byId(DB.items, r.itemId) || {};
      const machineRec = byId(DB.machines, r.machineId) || {};
      lines.push([
        r.date, nameOf(DB.shifts,r.shiftId), nameOf(DB.sites,r.siteId), nameOf(DB.locations,r.locationId),
        machineRec.machineCode||'', nameOf(DB.machines,r.machineId), itemRec.itemCode||'', nameOf(DB.items,r.itemId), itemRec.description||'', r.spm, r.weight||0, r.qty, r.rejectedQty||0,
        r.downtimeMinutes||0, downtimeSummaryText(r), r.operatorName,
        r.supervisorName||nameOf(DB.users,r.supervisorId), r.lastEditedByName||'', r.lastEditedAt||'', fmt1(c.oeePct), fmt1(c.downtimePct)
      ].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
    });
    const blob = new Blob([lines.join('\\n')], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `prf-report-${repFilters.start}_to_${repFilters.end}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
}

/* ================= BOOT ================= */
function renderSetupScreen(){
  document.getElementById('app').innerHTML = `
    <div class="login-wrap">
      <div class="login-card" style="max-width:480px;">
        <div class="brand-eyebrow">Setup Required</div>
        <div class="brand-title" style="font-size:26px;">Connect Supabase</div>
        <div class="brand-sub">This build needs a database connection before it can run.</div>
        <div class="login-err" style="margin-bottom:18px;">SUPABASE_URL / SUPABASE_ANON_KEY are not set yet.</div>
        <div class="helptext" style="font-size:12.5px;line-height:1.7;">
          1. Create a free project at <b style="color:var(--amber);">supabase.com</b><br>
          2. Open the SQL Editor and run the script in <b style="color:var(--amber);">SETUP.sql</b> (included alongside this file)<br>
          3. Go to Project Settings → API, copy your <b style="color:var(--amber);">Project URL</b> and <b style="color:var(--amber);">anon public key</b><br>
          4. Open this HTML file in a text editor and paste them into the <code style="color:var(--amber);">SUPABASE_URL</code> and <code style="color:var(--amber);">SUPABASE_ANON_KEY</code> constants near the top of the script<br>
          5. Save, re-upload to your host, and reload this page
        </div>
      </div>
    </div>`;
}

/* ---------------- auto sign-out on inactivity ----------------
   Protects accountability on shared shop-floor terminals: if a
   supervisor logs in and walks away without signing out, the
   session ends on its own after a period of no activity. */
const INACTIVITY_LIMIT_MS = 10 * 60 * 1000; // 10 minutes
let inactivityTimer = null;

function resetInactivityTimer(){
  if(inactivityTimer) clearTimeout(inactivityTimer);
  if(!SESSION) return;
  inactivityTimer = setTimeout(()=>{
    SESSION = null;
    LOGIN_MODE = 'login';
    LOGIN_ERR = 'You were signed out automatically after a period of inactivity.';
    render();
  }, INACTIVITY_LIMIT_MS);
}

function setupInactivityWatch(){
  ['click','keydown','touchstart','mousemove'].forEach(evt=>{
    document.addEventListener(evt, ()=>{ if(SESSION) resetInactivityTimer(); }, {passive:true});
  });
}

async function boot(){
  if(!CONFIGURED){ renderSetupScreen(); return; }
  document.getElementById('app').innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;color:var(--ink-dim);font-family:var(--mono);font-size:13px;letter-spacing:1px;">LOADING PRF DASHBOARD…</div>`;
  try{
    await loadAll();
    await seedIfEmpty();
  }catch(e){
    console.error(e);
  }
  BOOTED = true;
  setupInactivityWatch();
  render();
}
boot();