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

function pageAllowedRoutes(){
  if(PAGE_VIEW === 'entry') return ['newentry','entrylog'];
  if(PAGE_VIEW === 'dashboard') return ['dashboard'];
  // 'admin' (full) view — same role-based rules as before
  return SESSION && SESSION.role === 'admin'
    ? ['dashboard','newentry','entrylog','masterdata','reports']
    : ['dashboard','newentry','entrylog'];
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
    DB.shifts.push({id:uid('sh'),name:'Shift A (6-2)',durationMinutes:480});
    DB.shifts.push({id:uid('sh'),name:'Shift B (2-10)',durationMinutes:480});
    DB.shifts.push({id:uid('sh'),name:'Shift C (10-6)',durationMinutes:480});
    changed = true;
  }
  if(DB.reasons.length===0){
    ['Machine Breakdown','Die Change','Material Shortage','Power Failure','Planned Maintenance','No Operator'].forEach(n=>DB.reasons.push({id:uid('dtr'),name:n}));
    changed = true;
  }
  if(DB.machines.length===0){ DB.machines.push({id:uid('mc'), name:'Press-01', site: DB.sites[0]?.id||''}); changed = true; }
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

function fmt1(n){ return (Math.round(n*10)/10).toFixed(1); }
function safeDiv(a,b){ return b>0 ? a/b : 0; }

function entryCalc(e){
  const shift = byId(DB.shifts, e.shiftId);
  const available = shift ? shift.durationMinutes : 0;
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
  if(entries.length===0) return { forgingPct:0, oeePct:0, downtimePct:0, totalQty:0, totalDowntime:0, totalAvailable:0 };
  let sumStd=0, sumQty=0, sumAvail=0, sumRun=0, sumGood=0, sumDown=0;
  entries.forEach(e=>{
    const c = entryCalc(e);
    sumStd += c.standardQty; sumQty += Number(e.qty)||0; sumAvail += c.available;
    sumRun += c.runTime; sumGood += c.goodQty; sumDown += c.downtime;
  });
  const forgingPct = safeDiv(sumQty, sumStd) * 100;
  const availability = safeDiv(sumRun, sumAvail);
  const performance = safeDiv(sumQty, sumStd);
  const quality = sumQty>0 ? safeDiv(sumGood, sumQty) : 1;
  const oeePct = availability * performance * quality * 100;
  const downtimePct = safeDiv(sumDown, sumAvail) * 100;
  return { forgingPct, oeePct, downtimePct, totalQty:sumQty, totalDowntime:sumDown, totalAvailable:sumAvail };
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
      <div class="seed-note">
        First time here? Default admin login is <b>admin</b> / <b>admin123</b>. Change this password immediately after signing in via Master Data → Supervisor Accounts.<br><br>
        Note: this app stores accounts and records in your connected Supabase database, with passwords hashed before storage. It is suitable for internal shop-floor use, but access to the database is only as secure as your Supabase table policies — review SETUP.sql before going live with real data.
      </div>
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
    LOGIN_ERR=''; SESSION = {id:user.id, name:user.name, role:user.role}; ROUTE = pageAllowedRoutes()[0];
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
  const nav = items.map(it=>`
    <button class="nav-item ${ROUTE===it.key?'active':''}" data-route="${it.key}">
      <span class="dot"></span><span class="nav-label">${it.label}</span>
    </button>`).join('');
  return `
  <div class="shell">
    <div class="sidebar">
      <div class="side-brand">
        <div class="brand-eyebrow">PRF · ${viewLabel}</div>
        <div class="brand-title" style="font-size:20px;">Forging<br>Dashboard</div>
      </div>
      <nav>${nav}</nav>
      <div class="side-foot">
        <div class="who">${SESSION.name}</div>
        <div class="who-role">${SESSION.role}</div>
        <button class="btn btn-ghost btn-sm logout-btn" id="logoutBtn">Sign Out</button>
      </div>
    </div>
    <div class="main" id="mainArea">${renderPage()}</div>
  </div>`;
}

function attachShellEvents(){
  document.getElementById('logoutBtn').onclick = ()=>{ if(inactivityTimer) clearTimeout(inactivityTimer); SESSION=null; LOGIN_MODE='login'; render(); };
  document.querySelectorAll('.nav-item').forEach(btn=>{
    btn.onclick = ()=>{ ROUTE = btn.dataset.route; render(); };
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
  if(ROUTE==='reports' && SESSION.role==='admin') return pageReports();
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
  const filtered = DB.entries.filter(e=>inRange(e.date, start, end));
  const agg = aggregate(filtered);

  const mtdEntries = DB.entries.filter(e=>inRange(e.date, monthStartStr(), todayStr()));
  const ytdEntries = DB.entries.filter(e=>inRange(e.date, yearStartStr(), todayStr()));
  const mtd = aggregate(mtdEntries);
  const ytd = aggregate(ytdEntries);

  const byMachine = {};
  filtered.forEach(e=>{
    const key = e.machineId;
    if(!byMachine[key]) byMachine[key] = {qty:0, entries:[]};
    byMachine[key].qty += Number(e.qty)||0;
    byMachine[key].entries.push(e);
  });
  const machineRows = Object.keys(byMachine).map(mid=>{
    const g = byMachine[mid];
    const a = aggregate(g.entries);
    return {mid, qty:g.qty, oeePct:a.oeePct, downtimePct:a.downtimePct};
  }).sort((a,b)=>b.qty-a.qty);

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
    <div class="grid-3">
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
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel" style="margin-top:18px;">
    <div class="panel-title"><span class="bar"></span>Machine-wise Production (Selected Range)</div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Machine</th><th>Production Qty</th><th>OEE %</th><th>Down Time %</th></tr></thead>
        <tbody>
          ${machineRows.length===0 ? `<tr class="empty-row"><td colspan="4">No entries in this range.</td></tr>` :
            machineRows.map(r=>`
              <tr>
                <td>${nameOf(DB.machines, r.mid)}</td>
                <td style="font-family:var(--mono);">${r.qty}</td>
                <td style="font-family:var(--mono);color:${kpiColor(r.oeePct)};">${fmt1(r.oeePct)}%</td>
                <td style="font-family:var(--mono);">${fmt1(r.downtimePct)}%</td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>
  <div class="footer-note">Formulas: OEE % = Availability × Performance × Quality × 100 (Run Time/Available Time, Actual/Standard Qty, Good Qty/Actual Qty). Down Time % = Down Time ÷ Available Time × 100. Available Time comes from the Shift's configured duration in Master Data. Share your exact formulas any time and these can be adjusted.</div>
  `;
}

function attachDashboardEvents(){
  const sel = document.getElementById('dashRangeSel');
  if(sel) sel.onchange = ()=>{ dashRangeMode = sel.value; render(); };
  const s = document.getElementById('dashStart');
  const eEnd = document.getElementById('dashEnd');
  if(s) s.onchange = ()=>{ dashCustomStart = s.value; render(); };
  if(eEnd) eEnd.onchange = ()=>{ dashCustomEnd = eEnd.value; render(); };
}

/* ================= NEW ENTRY ================= */
let entryDraft = null;
let editingEntryId = null;

function blankDraft(){
  return {
    date: todayStr(), shiftId:'', siteId:'', locationId:'', machineId:'', itemId:'',
    spm:'', qty:'', rejectedQty:'', downtimeMinutes:'0', downtimeReasonId:'', operatorName:''
  };
}

function pageNewEntry(){
  if(!entryDraft) entryDraft = blankDraft();
  const d = entryDraft;
  const opts = (arr, val, placeholder)=>{
    return `<option value="">${placeholder}</option>` + arr.map(o=>`<option value="${o.id}" ${o.id===val?'selected':''}>${o.name}</option>`).join('');
  };
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
        <div class="field"><label>Location</label><select id="f_location" required>${opts(DB.locations, d.locationId, 'Select location')}</select></div>
        <div class="field"><label>Machine</label><select id="f_machine" required>${opts(DB.machines, d.machineId, 'Select machine')}</select></div>
        <div class="field"><label>Item</label><select id="f_item" required>${opts(DB.items, d.itemId, 'Select item')}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>SPM (auto from Master Data)</label><input type="number" id="f_spm" value="${d.spm}" readonly style="opacity:0.7;"></div>
        <div class="field"><label>Production Qty</label><input type="number" min="0" id="f_qty" value="${d.qty}" required></div>
        <div class="field"><label>Rejected Qty (optional)</label><input type="number" min="0" id="f_rejected" value="${d.rejectedQty}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Down Time (minutes)</label><input type="number" min="0" id="f_downtime" value="${d.downtimeMinutes}"></div>
        <div class="field"><label>Down Time Reason</label><select id="f_reason">${opts(DB.reasons, d.downtimeReasonId, 'Select reason (if any)')}</select></div>
        <div class="field"><label>Operator Name</label><input type="text" id="f_operator" value="${d.operatorName}" required></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Supervisor</label><input type="text" value="${SESSION.name}" readonly style="opacity:0.7;"></div>
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
  const machineSel = document.getElementById('f_machine');
  const itemSel = document.getElementById('f_item');
  const spmInput = document.getElementById('f_spm');
  const updateSpm = ()=>{
    const mid = machineSel.value, iid = itemSel.value;
    const spm = lookupSpm(mid, iid);
    spmInput.value = spm;
  };
  machineSel.onchange = updateSpm;
  itemSel.onchange = updateSpm;

  document.getElementById('clearEntryForm').onclick = ()=>{ entryDraft = blankDraft(); editingEntryId=null; render(); };

  document.getElementById('entryForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    const spmVal = spmInput.value;
    if(!spmVal){ alert('No SPM found for this Machine + Item combination. Please add it under Master Data → SPM first.'); return; }
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
      rejectedQty: Number(document.getElementById('f_rejected').value)||0,
      downtimeMinutes: Number(document.getElementById('f_downtime').value)||0,
      downtimeReasonId: document.getElementById('f_reason').value,
      operatorName: document.getElementById('f_operator').value,
      supervisorId: SESSION.id,
      supervisorName: SESSION.name,
      createdAt: new Date().toISOString()
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
let logFilters = { start:'', end:'', machineId:'', shiftId:'', siteId:'' };

function pageEntryLog(){
  let rows = DB.entries.slice().sort((a,b)=> (b.date+b.createdAt).localeCompare(a.date+a.createdAt));
  if(logFilters.start) rows = rows.filter(e=>e.date >= logFilters.start);
  if(logFilters.end) rows = rows.filter(e=>e.date <= logFilters.end);
  if(logFilters.machineId) rows = rows.filter(e=>e.machineId===logFilters.machineId);
  if(logFilters.shiftId) rows = rows.filter(e=>e.shiftId===logFilters.shiftId);
  if(logFilters.siteId) rows = rows.filter(e=>e.siteId===logFilters.siteId);

  const canManage = (row)=> SESSION.role==='admin' || row.supervisorId===SESSION.id;

  return `
  <div class="page-head">
    <div>
      <div class="page-eyebrow">Records</div>
      <div class="page-title">Entry Log</div>
    </div>
  </div>
  <div class="panel">
    <div class="filter-bar">
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
          <th>Date</th><th>Shift</th><th>Site</th><th>Location</th><th>Machine</th><th>Item</th>
          <th>SPM</th><th>Qty</th><th>Rej.</th><th>D/T Min</th><th>Reason</th><th>Operator</th><th>Supervisor</th><th></th>
        </tr></thead>
        <tbody>
        ${rows.length===0 ? `<tr class="empty-row"><td colspan="14">No entries found.</td></tr>` :
          rows.map(e=>`
            <tr>
              <td style="font-family:var(--mono);">${e.date}</td>
              <td>${nameOf(DB.shifts,e.shiftId)}</td>
              <td>${nameOf(DB.sites,e.siteId)}</td>
              <td>${nameOf(DB.locations,e.locationId)}</td>
              <td>${nameOf(DB.machines,e.machineId)}</td>
              <td>${nameOf(DB.items,e.itemId)}</td>
              <td style="font-family:var(--mono);">${e.spm}</td>
              <td style="font-family:var(--mono);">${e.qty}</td>
              <td style="font-family:var(--mono);">${e.rejectedQty||0}</td>
              <td style="font-family:var(--mono);">${e.downtimeMinutes||0}</td>
              <td>${e.downtimeReasonId ? nameOf(DB.reasons,e.downtimeReasonId) : '—'}</td>
              <td>${e.operatorName}</td>
              <td>${e.supervisorName||nameOf(DB.users,e.supervisorId)}</td>
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
  s.onchange = ()=>{ logFilters.start = s.value; render(); };
  e.onchange = ()=>{ logFilters.end = e.value; render(); };
  m.onchange = ()=>{ logFilters.machineId = m.value; render(); };
  sh.onchange = ()=>{ logFilters.shiftId = sh.value; render(); };
  st.onchange = ()=>{ logFilters.siteId = st.value; render(); };
  document.getElementById('lf_clear').onclick = ()=>{ logFilters = {start:'',end:'',machineId:'',shiftId:'',siteId:''}; render(); };

  document.querySelectorAll('[data-edit]').forEach(btn=>{
    btn.onclick = ()=>{
      const rec = DB.entries.find(x=>x.id===btn.dataset.edit);
      if(!rec) return;
      entryDraft = {...rec};
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
  `;
}

function renderMdTab(){
  if(mdTab==='machines') return simpleListEditor('machines', [{key:'name',label:'Machine Name'},{key:'site',label:'Site',type:'select',options:DB.sites}]);
  if(mdTab==='items') return simpleListEditor('items', [{key:'name',label:'Item Name'}]);
  if(mdTab==='locations') return simpleListEditor('locations', [{key:'name',label:'Location Name'}]);
  if(mdTab==='sites') return simpleListEditor('sites', [{key:'name',label:'Site Name'}]);
  if(mdTab==='shifts') return simpleListEditor('shifts', [{key:'name',label:'Shift Name'},{key:'durationMinutes',label:'Duration (min)',type:'number'}]);
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
    let added=0, skippedDup=0, skippedBad=0;
    rows.forEach(row=>{
      const rec = {id: uid(dbKey.slice(0,3))};
      let bad = false;
      fields.forEach(f=>{
        const val = row[f.key.toLowerCase()];
        if(f.type==='select'){
          const match = f.options.find(o=>o.name.toLowerCase() === String(val||'').trim().toLowerCase());
          if(!match){ bad = true; return; }
          rec[f.key] = match.id;
        } else if(f.key==='durationMinutes'){
          rec[f.key] = Number(val)||0;
        } else {
          rec[f.key] = (val||'').trim();
        }
      });
      if(bad || !rec.name){ skippedBad++; return; }
      const dup = DB[dbKey].some(x=>x.name && x.name.toLowerCase()===rec.name.toLowerCase());
      if(dup){ skippedDup++; return; }
      DB[dbKey].push(rec);
      added++;
    });
    if(added>0) await save(dbKey);
    alert(`Import finished: ${added} added, ${skippedDup} skipped (already exist), ${skippedBad} skipped (missing name or unmatched reference).`);
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
      const mName = (row['machine']||'').trim();
      const iName = (row['item']||'').trim();
      const spmVal = Number(row['spm']);
      const machine = DB.machines.find(m=>m.name.toLowerCase()===mName.toLowerCase());
      const item = DB.items.find(m=>m.name.toLowerCase()===iName.toLowerCase());
      if(!machine || !item || !spmVal){ skipped++; return; }
      const existing = DB.spm.find(s=>s.machineId===machine.id && s.itemId===item.id);
      if(existing){ existing.spm = spmVal; updated++; }
      else { DB.spm.push({id:uid('spm'), machineId:machine.id, itemId:item.id, spm:spmVal}); added++; }
    });
    if(added>0 || updated>0) await save('spm');
    alert(`SPM import finished: ${added} added, ${updated} updated, ${skipped} skipped (machine/item not found or invalid SPM value).`);
    input.value = '';
    render();
  };
}

function simpleListEditor(dbKey, fields){
  const list = DB[dbKey];
  const inputs = fields.map(f=>{
    if(f.type==='select'){
      return `<div class="field"><label>${f.label}</label><select id="md_${f.key}">${f.options.map(o=>`<option value="${o.id}">${o.name}</option>`).join('')}</select></div>`;
    }
    return `<div class="field"><label>${f.label}</label><input type="${f.type||'text'}" id="md_${f.key}"></div>`;
  }).join('');
  return `
  ${csvImportBlock(dbKey, fields)}
  <form class="mini-form" id="mdAddForm">
    ${inputs}
    <button class="btn btn-sm" type="submit">Add</button>
  </form>
  <div class="table-scroll">
    <table>
      <thead><tr>${fields.map(f=>`<th>${f.label}</th>`).join('')}<th></th></tr></thead>
      <tbody>
      ${list.length===0 ? `<tr class="empty-row"><td colspan="${fields.length+1}">No records yet.</td></tr>` :
        list.map(item=>`
          <tr>
            ${fields.map(f=> f.type==='select' ? `<td>${nameOf(f.options, item[f.key])}</td>` : `<td>${item[f.key]}</td>`).join('')}
            <td><button class="icon-btn danger" data-mddel="${dbKey}:${item.id}" title="Delete">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>
  `;
}

function spmEditor(){
  const spmFields = [{key:'machine'},{key:'item'},{key:'spm'}];
  const sampleMachine = DB.machines[0] ? DB.machines[0].name : 'Press-01';
  const sampleItem = DB.items[0] ? DB.items[0].name : 'Flange Blank';
  const csvTemplate = 'machine,item,spm\n' + sampleMachine + ',' + sampleItem + ',12';
  const dataUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvTemplate);
  return `
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px; flex-wrap:wrap; padding:12px; border:1px dashed var(--line); border-radius:4px;">
    <label class="btn btn-ghost btn-sm" style="cursor:pointer; margin:0;">
      Import CSV
      <input type="file" accept=".csv" id="csvImport_spm" style="display:none;">
    </label>
    <a href="${dataUri}" download="spm_template.csv" class="link-btn">Download template (columns: machine,item,spm — machine &amp; item must already exist)</a>
  </div>
  <form class="mini-form" id="spmAddForm">
    <div class="field"><label>Machine</label><select id="spm_machine">${DB.machines.map(m=>`<option value="${m.id}">${m.name}</option>`).join('')}</select></div>
    <div class="field"><label>Item</label><select id="spm_item">${DB.items.map(m=>`<option value="${m.id}">${m.name}</option>`).join('')}</select></div>
    <div class="field"><label>SPM</label><input type="number" min="0" id="spm_value" required></div>
    <button class="btn btn-sm" type="submit">Add / Update</button>
  </form>
  <div class="table-scroll">
    <table>
      <thead><tr><th>Machine</th><th>Item</th><th>SPM</th><th></th></tr></thead>
      <tbody>
      ${DB.spm.length===0 ? `<tr class="empty-row"><td colspan="4">No SPM records yet.</td></tr>` :
        DB.spm.map(s=>`
          <tr>
            <td>${nameOf(DB.machines, s.machineId)}</td>
            <td>${nameOf(DB.items, s.itemId)}</td>
            <td style="font-family:var(--mono);">${s.spm}</td>
            <td><button class="icon-btn danger" data-mddel="spm:${s.id}" title="Delete">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>
  `;
}

function usersEditor(){
  return `
  <button class="btn btn-sm" id="addUserBtn" type="button" style="margin-bottom:16px;">+ Add Supervisor Account</button>
  <div class="table-scroll">
    <table>
      <thead><tr><th>User ID</th><th>Name</th><th>Role</th><th></th></tr></thead>
      <tbody>
      ${DB.users.map(u=>`
        <tr>
          <td style="font-family:var(--mono);">${u.id}</td>
          <td>${u.name}</td>
          <td><span class="tag ${u.role==='admin'?'tag-role-admin':''}">${u.role}</span></td>
          <td>
            <div class="row-actions">
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
    btn.onclick = ()=>{ mdTab = btn.dataset.tab; render(); };
  });

  const fieldsMap = {
    machines:[{key:'name',label:'Machine Name'},{key:'site',label:'Site',type:'select',options:DB.sites}],
    items:[{key:'name',label:'Item Name'}],
    locations:[{key:'name',label:'Location Name'}],
    sites:[{key:'name',label:'Site Name'}],
    shifts:[{key:'name',label:'Shift Name'},{key:'durationMinutes',label:'Duration (min)',type:'number'}],
    reasons:[{key:'name',label:'Reason'}]
  };
  if(fieldsMap[mdTab]) wireCsvImport(mdTab, fieldsMap[mdTab]);
  if(mdTab==='spm') wireSpmCsvImport();

  const addForm = document.getElementById('mdAddForm');
  if(addForm) addForm.onsubmit = async (ev)=>{
    ev.preventDefault();
    const fields = fieldsMap[mdTab];
    const rec = {id: uid(mdTab.slice(0,3))};
    fields.forEach(f=>{
      const el = document.getElementById('md_'+f.key);
      rec[f.key] = f.key==='durationMinutes' ? Number(el.value) : el.value;
      if(f.key==='site') rec.site = el.value;
    });
    if(!rec.name && mdTab!=='machines' ){ }
    if(mdTab==='machines' && !rec.name){ alert('Name required'); return; }
    if(mdTab!=='machines' && !rec.name){ alert('Name required'); return; }
    DB[mdTab].push(rec);
    await save(mdTab);
    render();
  };

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

  document.querySelectorAll('[data-resetpw]').forEach(btn=>{
    btn.onclick = ()=>{ showModal(resetPwModal(btn.dataset.resetpw)); attachResetPwModalEvents(btn.dataset.resetpw); };
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
  return `
    <div class="modal-title">Add Supervisor Account</div>
    <form id="addUserForm">
      <div class="field"><label>User ID</label><input type="text" id="nu_id" required></div>
      <div class="field"><label>Full Name</label><input type="text" id="nu_name" required></div>
      <div class="field"><label>Role</label><select id="nu_role"><option value="supervisor">Supervisor</option><option value="admin">Admin</option></select></div>
      <div class="field"><label>Password</label><input type="password" id="nu_pw" required minlength="4"></div>
      <div class="field"><label>Security Question</label><input type="text" id="nu_sq" placeholder="e.g. What is your favorite tool?" required></div>
      <div class="field"><label>Security Answer</label><input type="text" id="nu_sa" required></div>
      <div class="form-actions">
        <button class="btn" type="submit">Create Account</button>
        <button class="btn btn-ghost" type="button" id="cancelModal">Cancel</button>
      </div>
    </form>`;
}
function attachUserModalEvents(){
  document.getElementById('cancelModal').onclick = closeModal;
  document.getElementById('addUserForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    const id = document.getElementById('nu_id').value.trim();
    if(DB.users.find(u=>u.id.toLowerCase()===id.toLowerCase())){ alert('User ID already exists.'); return; }
    const passwordHash = await sha256(document.getElementById('nu_pw').value);
    const securityAHash = await sha256(document.getElementById('nu_sa').value.trim().toLowerCase());
    DB.users.push({
      id, name: document.getElementById('nu_name').value.trim(),
      role: document.getElementById('nu_role').value,
      passwordHash, securityQ: document.getElementById('nu_sq').value.trim(), securityAHash
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

  const byMachine = {};
  rows.forEach(e=>{
    if(!byMachine[e.machineId]) byMachine[e.machineId] = [];
    byMachine[e.machineId].push(e);
  });
  const machineRows = Object.keys(byMachine).map(mid=>{
    const a = aggregate(byMachine[mid]);
    const qty = byMachine[mid].reduce((s,e)=>s+(Number(e.qty)||0),0);
    return {mid, qty, ...a};
  });

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

    <div class="grid-3" style="margin-bottom:20px;">
      <div class="kpi-card"><div class="kpi-label">OEE %</div><div class="kpi-value" style="color:${kpiColor(agg.oeePct)};font-size:20px;">${fmt1(agg.oeePct)}%</div></div>
      <div class="kpi-card"><div class="kpi-label">Down Time %</div><div class="kpi-value" style="font-size:20px;">${fmt1(agg.downtimePct)}%</div></div>
      <div class="kpi-card"><div class="kpi-label">Total Qty</div><div class="kpi-value" style="font-size:20px;">${agg.totalQty}</div></div>
    </div>

    <div class="panel-title" style="margin-bottom:10px;"><span class="bar"></span>Machine Summary</div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Machine</th><th>Qty</th><th>OEE %</th><th>Down Time %</th></tr></thead>
        <tbody>
          ${machineRows.length===0 ? `<tr class="empty-row"><td colspan="4">No data in this range.</td></tr>` :
            machineRows.map(r=>`
              <tr>
                <td>${nameOf(DB.machines,r.mid)}</td>
                <td style="font-family:var(--mono);">${r.qty}</td>
                <td style="font-family:var(--mono);">${fmt1(r.oeePct)}%</td>
                <td style="font-family:var(--mono);">${fmt1(r.downtimePct)}%</td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
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
    const header = ['Date','Shift','Site','Location','Machine','Item','SPM','Qty','Rejected','DowntimeMin','Reason','Operator','Supervisor','OeePct','DowntimePct'];
    const lines = [header.join(',')];
    rows.forEach(r=>{
      const c = entryCalc(r);
      lines.push([
        r.date, nameOf(DB.shifts,r.shiftId), nameOf(DB.sites,r.siteId), nameOf(DB.locations,r.locationId),
        nameOf(DB.machines,r.machineId), nameOf(DB.items,r.itemId), r.spm, r.qty, r.rejectedQty||0,
        r.downtimeMinutes||0, r.downtimeReasonId?nameOf(DB.reasons,r.downtimeReasonId):'', r.operatorName,
        r.supervisorName||nameOf(DB.users,r.supervisorId), fmt1(c.oeePct), fmt1(c.downtimePct)
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