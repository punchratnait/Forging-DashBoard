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

/* Admins and Department Heads always see all locations, even if a location was
   accidentally assigned to their account via Assign Location. */
function effectiveLocationId(){
  if(!SESSION) return '';
  if(SESSION.role === 'head' || SESSION.role === 'admin' || SESSION.role === 'management') return '';
  return SESSION.locationId || '';
}

function pageAllowedRoutes(){
  const role = SESSION && SESSION.role;
  const canSpm = role==='supervisor' || role==='head' || role==='admin';
  // Admin/Head/Management always see Dashboard. Operator/Supervisor only see it if their
  // account has been individually granted Dashboard Access in Master Data.
  const hasDashboard = role==='admin' || role==='head' || role==='management' || (SESSION && SESSION.canAccessDashboard===true);
  if(PAGE_VIEW === 'entry'){
    const base = canSpm ? ['newentry','entrylog','spm'] : ['newentry','entrylog'];
    return hasDashboard ? ['dashboard', ...base] : base;
  }
  if(PAGE_VIEW === 'dashboard') return ['dashboard','entrylog'];
  if(PAGE_VIEW === 'l1') return ['l1']; // gated at login (see canAccessL1 check), single-purpose URL
  // 'admin' (full) view — role-based rules
  if(role === 'admin') return ['dashboard','newentry','entrylog','masterdata','reports'];
  if(role === 'head') return ['dashboard','newentry','entrylog','reports','spm'];
  if(role === 'management') return ['dashboard','entrylog','reports']; // view-only, no entry submission
  if(role === 'marketing') return ['masterdata']; // filtered to Invoices + Customer Complaints only
  if(role === 'supervisor') return hasDashboard ? ['dashboard','newentry','entrylog','spm'] : ['newentry','entrylog','spm'];
  return hasDashboard ? ['dashboard','newentry','entrylog'] : ['newentry','entrylog']; // operator
}

const STORE_KEYS = {
  users:'prf_users', machines:'prf_machines', items:'prf_items',
  spm:'prf_machine_item_spm', locations:'prf_locations', sites:'prf_sites',
  shifts:'prf_shifts', reasons:'prf_downtime_reasons', entries:'prf_entries',
  invoices:'prf_invoices', plantmetrics:'prf_plant_metrics', complaints:'prf_complaints'
};

let DB = { users:[], machines:[], items:[], spm:[], locations:[], sites:[], shifts:[], reasons:[], entries:[], invoices:[], plantmetrics:[], complaints:[] };
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
    Object.keys(STORE_KEYS).forEach(k=>{
      if(k === 'entries') return; // entries load from their own real table now, not the shared blob
      DB[k] = map[STORE_KEYS[k]] || [];
    });
  }catch(e){ console.error('supabase load exception', e); }
  await loadEntriesTable();
}

/* Entries live in their own real Postgres table (prf_entries_v2), one row per
   entry, instead of the shared kv_store blob every other data type still uses.
   This is what fixes the last-write-wins overwrite bug: inserting/updating/
   deleting a single entry only ever touches that one row, so two people
   saving around the same time can never silently erase each other's work. */
function entryRowToObj(row){
  return {
    id: row.id, date: row.date, shiftId: row.shift_id, siteId: row.site_id,
    locationId: row.location_id, machineId: row.machine_id, itemId: row.item_id,
    spm: row.spm, qty: row.qty, weight: row.weight, rejectedQty: row.rejected_qty,
    downtimeMinutes: row.downtime_minutes, downtimeBlocks: row.downtime_blocks || [],
    operatorName: row.operator_name, supervisorId: row.supervisor_id, supervisorName: row.supervisor_name,
    createdAt: row.created_at, lastEditedBy: row.last_edited_by, lastEditedByName: row.last_edited_by_name,
    lastEditedAt: row.last_edited_at, batchId: row.batch_id
  };
}
function entryObjToRow(e){
  return {
    id: e.id, date: e.date, shift_id: e.shiftId, site_id: e.siteId,
    location_id: e.locationId, machine_id: e.machineId, item_id: e.itemId,
    spm: e.spm, qty: e.qty, weight: e.weight, rejected_qty: e.rejectedQty,
    downtime_minutes: e.downtimeMinutes, downtime_blocks: e.downtimeBlocks || [],
    operator_name: e.operatorName, supervisor_id: e.supervisorId, supervisor_name: e.supervisorName,
    created_at: e.createdAt, last_edited_by: e.lastEditedBy||null, last_edited_by_name: e.lastEditedByName||null,
    last_edited_at: e.lastEditedAt||null, batch_id: e.batchId||null
  };
}
async function loadEntriesTable(){
  try{
    const { data, error } = await supabaseClient.from('prf_entries_v2').select('*');
    if(error){ console.error('load entries error', error); return; }
    DB.entries = (data||[]).map(entryRowToObj);
  }catch(e){ console.error('load entries exception', e); }
}
async function insertEntries(recs){
  try{
    const rows = recs.map(entryObjToRow);
    const { error } = await supabaseClient.from('prf_entries_v2').insert(rows);
    if(error){ console.error('insert entries error', error); return false; }
    return true;
  }catch(e){ console.error('insert entries exception', e); return false; }
}
async function updateEntryRow(rec){
  try{
    const row = entryObjToRow(rec);
    const { id, ...fields } = row;
    const { error } = await supabaseClient.from('prf_entries_v2').update(fields).eq('id', id);
    if(error){ console.error('update entry error', error); return false; }
    return true;
  }catch(e){ console.error('update entry exception', e); return false; }
}
async function deleteEntryRow(id){
  try{
    const { error } = await supabaseClient.from('prf_entries_v2').delete().eq('id', id);
    if(error){ console.error('delete entry error', error); return false; }
    return true;
  }catch(e){ console.error('delete entry exception', e); return false; }
}
async function deleteAllEntriesTable(){
  try{
    const { error } = await supabaseClient.from('prf_entries_v2').delete().not('id', 'is', null);
    if(error){ console.error('clear entries error', error); return false; }
    return true;
  }catch(e){ console.error('clear entries exception', e); return false; }
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
function machineLabel(id){
  const m = byId(DB.machines,id);
  if(!m) return '—';
  return m.machineCode || m.name;
}
function machineCodeOf(id){ const m=byId(DB.machines,id); return m ? (m.machineCode || '—') : '—'; }
function itemCodeOf(id){ const it=byId(DB.items,id); return it ? (it.itemCode || '—') : '—'; }

function fmt1(n){ return (Math.round(n*10)/10).toFixed(1); }
function fmt3(n){ return (Math.round(n*1000)/1000).toFixed(3); }
function fmtKgTon(kg){ return `${fmt1(kg)} kg <span style="color:var(--ink-dim);">(${fmt3(kg/1000)} MT)</span>`; }
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
  const rawDowntime = Number(e.downtimeMinutes)||0;
  // Downtime can't physically exceed the entry's own Available Time — if it does (e.g. from
  // overlapping down-time blocks logged before validation existed), cap it here so every
  // downstream metric (Availability, OEE, Down Time %, loss breakdowns) stays consistent.
  const downtime = Math.min(rawDowntime, available);
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
  const availability = Math.min(safeDiv(sumRun, sumAvail), 1);
  const performance = Math.min(safeDiv(sumQty, sumStd), 1);
  const quality = sumQty>0 ? Math.min(safeDiv(sumGood, sumQty), 1) : 1;
  const oeePct = availability * performance * quality * 100;
  const downtimePct = safeDiv(sumDown, sumAvail) * 100;
  return { forgingPct, oeePct, downtimePct, totalQty:sumQty, totalWeightKg:sumWeightG/1000, totalDowntime:sumDown, totalAvailable:sumAvail };
}

/* Loss waterfall: OEE% + each Down Time reason's % of Available Time + Speed Loss%
   (the unaccounted remainder) should sum to ~100%. Speed Loss = 100 - (OEE% + sum of reason %). */
/* Adds one entry's down time to a reason->minutes map, capped at that entry's own
   Available Time (via entryCalc's already-capped downtime). If the entry's raw down-time
   blocks sum to more than that cap (e.g. overlapping blocks logged before validation
   existed), every block is scaled down proportionally so this entry never contributes
   more than it physically could — keeping every downstream percentage consistent. */
function addEntryLossToMap(e, lossMap){
  const c = entryCalc(e);
  const cap = c.downtime;
  if(e.downtimeBlocks && e.downtimeBlocks.length){
    const rawTotal = e.downtimeBlocks.reduce((s,b)=>s+(Number(b.minutes)||0),0);
    const scale = (rawTotal > cap && rawTotal > 0) ? cap/rawTotal : 1;
    e.downtimeBlocks.forEach(b=>{
      const mins = (Number(b.minutes)||0) * scale;
      if(mins > 0){
        const key = b.reasonId || '__unspecified';
        lossMap[key] = (lossMap[key]||0) + mins;
      }
    });
  } else {
    const dt = Math.min(Number(e.downtimeMinutes)||0, cap);
    if(dt > 0){
      const key = e.downtimeReasonId || '__unspecified';
      lossMap[key] = (lossMap[key]||0) + dt;
    }
  }
}

function lossBreakdown(entries, oeePct){
  const lossMap = {}; // reasonId -> total minutes
  let totalAvailable = 0;
  entries.forEach(e=>{
    const c = entryCalc(e);
    totalAvailable += c.available;
    addEntryLossToMap(e, lossMap);
  });
  let reasons = Object.keys(lossMap).map(key=>{
    const label = key==='__unspecified' ? 'Unspecified' : nameOf(DB.reasons, key);
    const pct = safeDiv(lossMap[key], totalAvailable) * 100;
    return { label, minutes: lossMap[key], pct };
  }).sort((a,b)=>b.pct-a.pct);
  let reasonPctSum = reasons.reduce((s,r)=>s+r.pct, 0);
  const lossBudget = Math.max(0, 100 - oeePct); // total room left for reasons + speed loss
  const wasClamped = reasonPctSum > lossBudget + 0.05;
  if(wasClamped && reasonPctSum > 0){
    // Down time entries overlap (or other inconsistency) pushed raw reason % past what's left
    // after OEE. Scale every reason proportionally so the list always sums exactly to what's
    // available — keeps each reason's relative share correct while guaranteeing the total
    // never implies more than 100% overall.
    const scale = lossBudget / reasonPctSum;
    reasons = reasons.map(r=>({ ...r, pct: r.pct * scale }));
    reasonPctSum = lossBudget;
  }
  const speedLossPct = Math.max(0, lossBudget - reasonPctSum);
  return { reasons, reasonPctSum, speedLossPct, wasClamped };
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
      addEntryLossToMap(e, lossMap);
    });
    const lossParts = Object.keys(lossMap)
      .sort((x,y)=>lossMap[y]-lossMap[x])
      .map(key=>{
        const label = key==='__unspecified' ? 'Unspecified' : nameOf(DB.reasons, key);
        return { label, minutes: Math.round(lossMap[key]) };
      });
    const lossText = lossParts.length ? lossParts.map(p=>`${p.label}: ${p.minutes}m`).join(', ') : '—';
    let lossHtml = '—';
    if(lossParts.length === 1){
      lossHtml = `${lossParts[0].label}: ${lossParts[0].minutes}m`;
    } else if(lossParts.length > 1){
      const totalMin = lossParts.reduce((s,p)=>s+p.minutes,0);
      const detailLines = lossParts.map(p=>`<div style="padding:2px 0;">${p.label}: ${p.minutes}m</div>`).join('');
      lossHtml = `<details class="dt-details"><summary>${lossParts.length} reasons · ${totalMin}m</summary>${detailLines}</details>`;
    }
    return { mid, plannedQty:Math.round(plannedQty), actualQty, weightKg:a.totalWeightKg, oeePct:a.oeePct, downtimePct:a.downtimePct, lossText, lossHtml };
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
      <div class="brand-title">PRF Manufacturing<br>Dashboard</div>
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
    const userHasDashboard = user.role==='admin' || user.role==='head' || user.role==='management' || user.canAccessDashboard===true;
    if(PAGE_VIEW === 'dashboard' && !userHasDashboard){
      LOGIN_ERR = 'Your account does not have Dashboard Access. Contact your Admin to request it, or use the Entry link instead.';
      render();
      return;
    }
    const userHasL1 = user.role==='admin' || user.role==='marketing' || user.canAccessL1===true;
    if(PAGE_VIEW === 'l1' && !userHasL1){
      LOGIN_ERR = 'Your account does not have access to this Executive Dashboard. Contact your Admin to request it.';
      render();
      return;
    }
    LOGIN_ERR=''; SESSION = {id:user.id, name:user.name, role:user.role, locationId:user.locationId||'', canAccessDashboard:user.canAccessDashboard===true, canAccessL1:user.canAccessL1===true}; ROUTE = pageAllowedRoutes()[0];
    try{ sessionStorage.setItem('prf_session_userid', user.id); }catch(e){}
    draftPromptDismissed = false;
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
  const labels = {dashboard:'Dashboard', newentry:'New Entry', entrylog:'Entry Log', masterdata:'Master Data', reports:'Reports', spm:'SPM', l1:'Executive Dashboard'};
  return pageAllowedRoutes().map(key=>({key, label:labels[key]}));
}

function renderShell(){
  const items = navItems();
  const viewLabel = PAGE_VIEW==='entry' ? 'ENTRY TERMINAL' : PAGE_VIEW==='dashboard' ? 'MANAGEMENT VIEW' : PAGE_VIEW==='l1' ? 'EXECUTIVE VIEW' : 'ADMIN CONSOLE';
  const labels = {dashboard:'Dashboard', newentry:'New Entry', entrylog:'Entry Log', masterdata:'Master Data', reports:'Reports', spm:'SPM', l1:'Executive Dashboard'};
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
        <div class="brand-title" style="font-size:20px;">Manufacturing<br>Dashboard</div>
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
  document.getElementById('logoutBtn').onclick = ()=>{ if(inactivityTimer) clearTimeout(inactivityTimer); try{ sessionStorage.removeItem('prf_session_userid'); }catch(e){} SESSION=null; LOGIN_MODE='login'; draftPromptDismissed=false; entryDraft=null; editingEntryId=null; render(); };
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
  if(ROUTE==='masterdata' && (SESSION.role==='admin' || SESSION.role==='marketing')) return pageMasterData();
  if(ROUTE==='reports' && (SESSION.role==='admin' || SESSION.role==='head' || SESSION.role==='management')) return pageReports();
  if(ROUTE==='spm' && (SESSION.role==='admin' || SESSION.role==='head' || SESSION.role==='supervisor')) return pageSpmOnly();
  if(ROUTE==='l1') return pageL1Dashboard();
  ROUTE = allowed[0];
  return renderPage();
}

function attachPageEvents(){
  if(ROUTE==='dashboard') attachDashboardEvents();
  if(ROUTE==='newentry') attachNewEntryEvents();
  if(ROUTE==='entrylog') attachEntryLogEvents();
  if(ROUTE==='masterdata') attachMasterDataEvents();
  if(ROUTE==='reports') attachReportsEvents();
  if(ROUTE==='spm') attachMasterDataEvents(); // shared logic; unrelated tab elements simply won't be found
  if(ROUTE==='l1') attachL1DashboardEvents();
}

/* ================= DASHBOARD ================= */
let dashRangeMode = 'mtd'; // mtd | ytd | custom
let dashCustomStart = monthStartStr();
let dashCustomEnd = todayStr();

// Summary Matrix (top of Dashboard): plant selection + Yesterday/MTD/YTD/Custom at a glance
let matrixPlant = ''; // '' = Consolidated (all locations)
let matrixCustomStart = '';
let matrixCustomEnd = '';

function yesterdayStr(){
  const d = new Date();
  d.setDate(d.getDate()-1);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

function renderSummaryMatrix(){
  const restrictedLoc = effectiveLocationId();
  const showSelector = !restrictedLoc; // only unrestricted roles (Head/Admin/Management/unrestricted accounts) get plant selection
  const activePlant = restrictedLoc || matrixPlant;

  const periods = [
    { key:'yesterday', label:'Yesterday', start: yesterdayStr(), end: yesterdayStr() },
    { key:'mtd', label:'MTD', start: monthStartStr(), end: todayStr() },
    { key:'ytd', label:'YTD', start: yearStartStr(), end: todayStr() },
    { key:'custom', label:'Custom Date', start: matrixCustomStart, end: matrixCustomEnd }
  ];

  const cells = periods.map(p=>{
    if(p.key==='custom' && (!p.start || !p.end)) return null;
    let entries = DB.entries.filter(e=> e.date >= p.start && e.date <= p.end);
    if(activePlant) entries = entries.filter(e=>e.locationId===activePlant);
    const agg = aggregate(entries);
    return { nos: agg.totalQty, ton: agg.totalWeightKg/1000, oee: agg.oeePct };
  });

  const plantSelector = showSelector ? `
    <div style="display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap;">
      <button class="tab-btn ${matrixPlant===''?'active':''}" data-matrixplant="" type="button">Consolidated</button>
      ${DB.locations.map(l=>`<button class="tab-btn ${matrixPlant===l.id?'active':''}" data-matrixplant="${l.id}" type="button">${l.name}</button>`).join('')}
    </div>` : `<div class="helptext" style="margin-bottom:14px;">Showing your assigned location: <b style="color:var(--ink);">${nameOf(DB.locations, activePlant)}</b>.</div>`;

  const colHeader = (p)=>{
    if(p.key !== 'custom') return `<th>${p.label}</th>`;
    return `<th style="min-width:200px;">${p.label}<div style="display:flex; gap:4px; margin-top:6px; align-items:center;">
      <input type="date" id="matrixCustomStart" value="${matrixCustomStart}" style="width:100%; font-size:11px; padding:4px;">
      <input type="date" id="matrixCustomEnd" value="${matrixCustomEnd}" style="width:100%; font-size:11px; padding:4px;">
      ${(matrixCustomStart || matrixCustomEnd) ? `<button class="icon-btn" id="matrixCustomClear" type="button" title="Clear custom dates" style="flex-shrink:0; width:22px; height:22px; font-size:11px;">✕</button>` : ''}
    </div></th>`;
  };
  const cellVal = (i, field, fmtFn)=>{
    const c = cells[i];
    if(!c) return periods[i].key==='custom' ? '<span style="color:var(--ink-dim);">Pick dates</span>' : '—';
    return fmtFn(c[field]);
  };

  return `
  <div class="panel">
    <div class="panel-title"><span class="bar"></span>Summary Matrix</div>
    ${plantSelector}
    <div class="table-scroll">
      <table>
        <thead><tr><th></th>${periods.map(colHeader).join('')}</tr></thead>
        <tbody>
          <tr><td>Qty (Nos.)</td>${periods.map((p,i)=>`<td style="font-family:var(--mono);">${cellVal(i,'nos',v=>v.toLocaleString())}</td>`).join('')}</tr>
          <tr><td>Metric Ton</td>${periods.map((p,i)=>`<td style="font-family:var(--mono);">${cellVal(i,'ton',v=>fmt3(v))}</td>`).join('')}</tr>
          <tr><td>OEE %</td>${periods.map((p,i)=>{
            const c = cells[i];
            if(!c) return `<td>${p.key==='custom' ? '<span style="color:var(--ink-dim);">Pick dates</span>' : '—'}</td>`;
            return `<td style="font-family:var(--mono);color:${kpiColor(c.oee)};">${fmt1(c.oee)}%</td>`;
          }).join('')}</tr>
        </tbody>
      </table>
    </div>
  </div>
  `;
}

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
  const loss = lossBreakdown(filtered, agg.oeePct);

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

  ${renderSummaryMatrix()}

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
        <div style="height:72px;display:flex;flex-direction:column;align-items:center;justify-content:center;">
          <div class="kpi-value" style="font-size:26px;font-family:var(--mono);color:var(--ink);">${fmt1(agg.totalWeightKg)} kg</div>
          <div style="font-size:13px;font-family:var(--mono);color:var(--ink-dim);margin-top:2px;">${fmt3(agg.totalWeightKg/1000)} MT</div>
        </div>
        <div class="gauge-cap">Total Production Weight</div>
      </div>
    </div>

    <div style="margin-top:22px; padding-top:20px; border-top:1px solid var(--line);">
      <div style="font-size:11px; letter-spacing:1px; color:var(--ink-dim); text-transform:uppercase; margin-bottom:10px;">OEE + Down Time + Speed Loss = 100%</div>
      <div style="display:flex; height:34px; border-radius:6px; overflow:hidden;">
        <div style="width:${Math.max(agg.oeePct,0)}%; background:${kpiColor(agg.oeePct)}; display:flex; align-items:center; justify-content:center; font-size:11.5px; font-weight:700; color:#0b0c0e; white-space:nowrap; overflow:hidden;">${agg.oeePct>=8?fmt1(agg.oeePct)+'%':''}</div>
        <div style="width:${Math.max(loss.reasonPctSum,0)}%; background:var(--amber); display:flex; align-items:center; justify-content:center; font-size:11.5px; font-weight:700; color:#0b0c0e; white-space:nowrap; overflow:hidden;">${loss.reasonPctSum>=8?fmt1(loss.reasonPctSum)+'%':''}</div>
        <div style="width:${Math.max(loss.speedLossPct,0)}%; background:#7ea8ff; display:flex; align-items:center; justify-content:center; font-size:11.5px; font-weight:700; color:#0b0c0e; white-space:nowrap; overflow:hidden;">${loss.speedLossPct>=8?fmt1(loss.speedLossPct)+'%':''}</div>
      </div>
      <div style="display:flex; gap:22px; flex-wrap:wrap; font-size:12.5px; margin-top:12px;">
        <div><span style="display:inline-block; width:10px; height:10px; border-radius:2px; background:${kpiColor(agg.oeePct)}; margin-right:6px;"></span>OEE: <b style="color:var(--ink);">${fmt1(agg.oeePct)}%</b></div>
        <div><span style="display:inline-block; width:10px; height:10px; border-radius:2px; background:var(--amber); margin-right:6px;"></span>Down Time: <b style="color:var(--ink);">${fmt1(loss.reasonPctSum)}%</b></div>
        <div><span style="display:inline-block; width:10px; height:10px; border-radius:2px; background:#7ea8ff; margin-right:6px;"></span>Speed Loss: <b style="color:var(--ink);">${fmt1(loss.speedLossPct)}%</b></div>
      </div>
    </div>
  </div>

  <div class="panel" style="margin-top:18px;">
    <div class="panel-title"><span class="bar"></span>Loss Breakdown (${dashRangeMode==='mtd'?'Month to Date':dashRangeMode==='ytd'?'Year to Date':'Selected Range'})</div>
    <details class="dt-details" style="max-width:none;">
      <summary style="font-size:14px; white-space:normal;">Total Loss: ${fmt1(100 - agg.oeePct)}% <span style="color:var(--ink-dim); font-weight:400;">(click to view breakdown)</span></summary>
      <div class="table-scroll" style="margin-top:12px;">
        <table>
          <thead><tr><th>Component</th><th>% of Available Time</th></tr></thead>
          <tbody>
            <tr><td>OEE %</td><td style="font-family:var(--mono);color:${kpiColor(agg.oeePct)};">${fmt1(agg.oeePct)}%</td></tr>
            ${loss.reasons.length===0 ? '' : loss.reasons.map(r=>`
            <tr><td>${r.label}</td><td style="font-family:var(--mono);">${fmt1(r.pct)}%</td></tr>`).join('')}
            <tr style="border-top:1px solid var(--line);">
              <td><b>Speed Loss %</b> <span style="color:var(--ink-dim);font-size:11.5px;">(100 − OEE − above reasons)</span></td>
              <td style="font-family:var(--mono);font-weight:700;color:var(--amber);">${fmt1(loss.speedLossPct)}%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="helptext" style="margin-top:10px;">Speed Loss represents output lost to running below rated speed for reasons not captured in a logged Down Time entry — minor stops, slow cycles, etc. ${loss.wasClamped ? 'The reason percentages above have been scaled down proportionally, and Speed Loss shows 0% — the raw logged down time exceeded what\'s mathematically left after OEE, most likely from overlapping down time entries. Each reason\'s relative share is preserved, but the underlying entries in this range are worth reviewing for overlapping or duplicate down time.' : ''}</div>
    </details>
  </div>

  <div class="grid-2" style="margin-top:18px;">
    <div class="panel">
      <div class="panel-title"><span class="bar"></span>MTD Snapshot</div>
      <table>
        <tbody>
          <tr><td>OEE %</td><td style="text-align:right;font-family:var(--mono);">${fmt1(mtd.oeePct)}%</td></tr>
          <tr><td>Down Time %</td><td style="text-align:right;font-family:var(--mono);">${fmt1(mtd.downtimePct)}%</td></tr>
          <tr><td>Total Production Qty</td><td style="text-align:right;font-family:var(--mono);">${mtd.totalQty}</td></tr>
          <tr><td>Total Production Weight</td><td style="text-align:right;font-family:var(--mono);">${fmtKgTon(mtd.totalWeightKg)}</td></tr>
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
          <tr><td>Total Production Weight</td><td style="text-align:right;font-family:var(--mono);">${fmtKgTon(ytd.totalWeightKg)}</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel" style="margin-top:18px;">
    <div class="panel-title"><span class="bar"></span>Machine-wise Production (Selected Range)</div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Machine</th><th>Planned Qty</th><th>Actual Qty</th><th>Weight</th><th>OEE %</th><th>Losses (Reason: Minutes)</th><th></th></tr></thead>
        <tbody>
          ${machineRows.length===0 ? `<tr class="empty-row"><td colspan="7">No entries in this range.</td></tr>` :
            machineRows.map(r=>`
              <tr>
                <td title="${nameOf(DB.machines, r.mid)}">${machineLabel(r.mid)}</td>
                <td style="font-family:var(--mono);">${r.plannedQty}</td>
                <td style="font-family:var(--mono);">${r.actualQty}</td>
                <td style="font-family:var(--mono); white-space:nowrap;">${fmt1(r.weightKg)} kg <span style="color:var(--ink-dim); font-size:11.5px;">(${fmt3(r.weightKg/1000)} MT)</span></td>
                <td style="font-family:var(--mono);color:${kpiColor(r.oeePct)};">${fmt1(r.oeePct)}%</td>
                <td style="font-size:12.5px;color:var(--ink-dim);">${r.lossHtml}</td>
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

  document.querySelectorAll('[data-matrixplant]').forEach(btn=>{
    btn.onclick = ()=>{ matrixPlant = btn.dataset.matrixplant; render(); };
  });
  const mStart = document.getElementById('matrixCustomStart');
  const mEnd = document.getElementById('matrixCustomEnd');
  if(mStart) mStart.onchange = ()=>{ matrixCustomStart = mStart.value; render(); };
  if(mEnd) mEnd.onchange = ()=>{ matrixCustomEnd = mEnd.value; render(); };
  const mClear = document.getElementById('matrixCustomClear');
  if(mClear) mClear.onclick = ()=>{ matrixCustomStart = ''; matrixCustomEnd = ''; render(); };
}

/* ================= L1 EXECUTIVE DASHBOARD ================= */
let l1CustomStart = '';
let l1CustomEnd = '';

function computeRevenueForRange(start, end, partyType){
  let invs = DB.invoices.filter(i=> i.date>=start && i.date<=end);
  if(partyType) invs = invs.filter(i=>i.partyType===partyType);
  const totalValue = invs.reduce((s,i)=>s+(Number(i.value)||0), 0);
  return totalValue / 10000000; // paise-free rupees -> crores (1 Cr = 1,00,00,000)
}

function topCustomers(n){
  const map = {};
  DB.invoices.forEach(inv=>{
    const key = inv.partyName || 'Unknown';
    map[key] = (map[key]||0) + (Number(inv.value)||0);
  });
  return Object.keys(map)
    .map(name=>({ name, value: map[name] }))
    .sort((a,b)=>b.value-a.value)
    .slice(0, n);
}

function plantMetricsAggForRange(start, end){
  const rows = DB.plantmetrics.filter(r=> r.date>=start && r.date<=end);
  const sum = (key)=> rows.reduce((s,r)=>s+(Number(r[key])||0), 0);
  const avg = (key)=> rows.length ? sum(key)/rows.length : 0;
  return {
    cnc1Oee: avg('cnc1Oee'), cnc1Nos: sum('cnc1Nos'),
    cnc2Oee: avg('cnc2Oee'), cnc2Nos: sum('cnc2Nos'),
    finishedGoodsMt: sum('finishedGoodsMt'),
    dispatchQty: sum('dispatchQty'), dispatchMt: sum('dispatchMt')
  };
}

function pageL1Dashboard(){
  const periods = [
    { key:'yesterday', label:'Yesterday', start: yesterdayStr(), end: yesterdayStr() },
    { key:'mtd', label:'MTD', start: monthStartStr(), end: todayStr() },
    { key:'ytd', label:'YTD', start: yearStartStr(), end: todayStr() },
    { key:'custom', label:'Custom Date', start: l1CustomStart, end: l1CustomEnd }
  ];
  const revenueRow = (partyType)=> periods.map(p=>{
    if(p.key==='custom' && (!p.start || !p.end)) return null;
    return computeRevenueForRange(p.start, p.end, partyType);
  });
  const totalRow = revenueRow(null);
  const domesticRow = revenueRow('Domestic');
  const exportRow = revenueRow('Export');

  const colHeader = (p)=>{
    if(p.key !== 'custom') return `<th>${p.label}</th>`;
    return `<th style="min-width:200px;">${p.label}<div style="display:flex; gap:4px; margin-top:6px; align-items:center;">
      <input type="date" id="l1CustomStart" value="${l1CustomStart}" style="width:100%; font-size:11px; padding:4px;">
      <input type="date" id="l1CustomEnd" value="${l1CustomEnd}" style="width:100%; font-size:11px; padding:4px;">
      ${(l1CustomStart || l1CustomEnd) ? `<button class="icon-btn" id="l1CustomClear" type="button" title="Clear custom dates" style="flex-shrink:0; width:22px; height:22px; font-size:11px;">✕</button>` : ''}
    </div></th>`;
  };
  const cellFmt = (v)=> v===null ? '<span style="color:var(--ink-dim);">Pick dates</span>' : `₹ ${fmt3(v)} Cr`;

  const top7 = topCustomers(7);
  const pm = plantMetricsAggForRange(monthStartStr(), todayStr());
  const forgingAgg = aggregate(DB.entries.filter(e=>inRange(e.date, monthStartStr(), todayStr())));

  const canAddComplaint = SESSION.role==='marketing' || SESSION.role==='admin';
  const complaintsSorted = DB.complaints.slice().sort((a,b)=> (b.date||'').localeCompare(a.date||''));

  return `
  <div class="page-head">
    <div>
      <div class="page-eyebrow">Executive Overview</div>
      <div class="page-title">Executive Dashboard</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-title"><span class="bar"></span>Revenue Generated</div>
    <div class="table-scroll">
      <table>
        <thead><tr><th></th>${periods.map(colHeader).join('')}</tr></thead>
        <tbody>
          <tr><td><b>Total</b></td>${totalRow.map(v=>`<td style="font-family:var(--mono); font-weight:700;">${cellFmt(v)}</td>`).join('')}</tr>
          <tr><td>Domestic</td>${domesticRow.map(v=>`<td style="font-family:var(--mono);">${cellFmt(v)}</td>`).join('')}</tr>
          <tr><td>Export</td>${exportRow.map(v=>`<td style="font-family:var(--mono);">${cellFmt(v)}</td>`).join('')}</tr>
        </tbody>
      </table>
    </div>
    <div class="helptext" style="margin-top:8px;">Revenue = sum of Invoice Value (net of tax) for the period, shown in ₹ Crores (1 Cr = ₹1,00,00,000). Maintain invoice records under Master Data → Invoices.</div>
  </div>

  <div class="panel" style="margin-top:18px;">
    <div class="panel-title"><span class="bar"></span>Top 7 Customers (All-Time, Sale-wise)</div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Customer</th><th>Sale (₹ Cr)</th></tr></thead>
        <tbody>
          ${top7.length===0 ? `<tr class="empty-row"><td colspan="2">No invoice data yet.</td></tr>` :
            top7.map(c=>`<tr><td>${c.name}</td><td style="font-family:var(--mono);">₹ ${fmt3(c.value/10000000)} Cr</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel" style="margin-top:18px;">
    <div class="panel-title"><span class="bar"></span>Plant Performance (Month to Date)</div>
    <div class="grid-4">
      <div class="kpi-card"><div class="kpi-label">Forging OEE %</div><div class="kpi-value" style="font-size:20px;color:${kpiColor(forgingAgg.oeePct)};">${fmt1(forgingAgg.oeePct)}%</div></div>
      <div class="kpi-card"><div class="kpi-label">Forging (MT)</div><div class="kpi-value" style="font-size:20px;">${fmt3(forgingAgg.totalWeightKg/1000)}</div></div>
      <div class="kpi-card"><div class="kpi-label">CNC1 OEE %</div><div class="kpi-value" style="font-size:20px;color:${kpiColor(pm.cnc1Oee)};">${fmt1(pm.cnc1Oee)}%</div></div>
      <div class="kpi-card"><div class="kpi-label">CNC1 Nos.</div><div class="kpi-value" style="font-size:20px;">${pm.cnc1Nos.toLocaleString()}</div></div>
      <div class="kpi-card"><div class="kpi-label">CNC2 OEE %</div><div class="kpi-value" style="font-size:20px;color:${kpiColor(pm.cnc2Oee)};">${fmt1(pm.cnc2Oee)}%</div></div>
      <div class="kpi-card"><div class="kpi-label">CNC2 Nos.</div><div class="kpi-value" style="font-size:20px;">${pm.cnc2Nos.toLocaleString()}</div></div>
      <div class="kpi-card"><div class="kpi-label">Finished Goods (MT)</div><div class="kpi-value" style="font-size:20px;">${fmt3(pm.finishedGoodsMt)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Dispatch Qty</div><div class="kpi-value" style="font-size:20px;">${pm.dispatchQty.toLocaleString()}</div></div>
    </div>
    <div class="grid-4" style="margin-top:16px;">
      <div class="kpi-card"><div class="kpi-label">Dispatch (MT)</div><div class="kpi-value" style="font-size:20px;">${fmt3(pm.dispatchMt)}</div></div>
    </div>
    <div class="helptext" style="margin-top:10px;">Forging figures come live from production entries (Consolidated, all plants). CNC1 (Inhouse), CNC2 (Outsource), Finished Goods, and Dispatch are entered daily under Master Data → Plant Metrics.</div>
  </div>

  <div class="panel" style="margin-top:18px;">
    <div class="panel-title"><span class="bar"></span>Customer Complaints</div>
    ${canAddComplaint ? `
    <form class="mini-form" id="l1ComplaintForm" style="margin-bottom:16px;">
      <div class="field"><label>Date</label><input type="date" id="l1c_date" value="${todayStr()}" required></div>
      <div class="field" style="flex:1; min-width:180px;"><label>Customer Name</label><input type="text" id="l1c_customer" required></div>
      <div class="field" style="flex:2; min-width:240px;"><label>Remark</label><input type="text" id="l1c_remark" required></div>
      <button class="btn btn-sm" type="submit">Add Complaint</button>
    </form>` : ''}
    <div class="table-scroll">
      <table>
        <thead><tr><th>Date</th><th>Customer</th><th>Remark</th><th></th></tr></thead>
        <tbody>
          ${complaintsSorted.length===0 ? `<tr class="empty-row"><td colspan="4">No complaints logged.</td></tr>` :
            complaintsSorted.map(c=>`<tr><td style="font-family:var(--mono);">${c.date}</td><td>${c.customerName}</td><td>${c.remark}</td><td>${canAddComplaint ? `<button class="icon-btn danger" data-l1delcomplaint="${c.id}" title="Delete">✕</button>` : ''}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${!canAddComplaint ? `<div class="helptext" style="margin-top:10px;">Only Marketing and Admin accounts can add or remove complaint records.</div>` : ''}
  </div>
  `;
}

function attachL1DashboardEvents(){
  const s = document.getElementById('l1CustomStart');
  const e = document.getElementById('l1CustomEnd');
  if(s) s.onchange = ()=>{ l1CustomStart = s.value; render(); };
  if(e) e.onchange = ()=>{ l1CustomEnd = e.value; render(); };
  const clearBtn = document.getElementById('l1CustomClear');
  if(clearBtn) clearBtn.onclick = ()=>{ l1CustomStart=''; l1CustomEnd=''; render(); };

  const complaintForm = document.getElementById('l1ComplaintForm');
  if(complaintForm) complaintForm.onsubmit = async (ev)=>{
    ev.preventDefault();
    const rec = {
      id: uid('cmp'),
      date: document.getElementById('l1c_date').value,
      customerName: document.getElementById('l1c_customer').value.trim(),
      remark: document.getElementById('l1c_remark').value.trim()
    };
    if(!rec.customerName || !rec.remark){ alert('Customer Name and Remark are required.'); return; }
    DB.complaints.push(rec);
    const ok = await save('complaints');
    render();
    if(!ok) alert('Warning: complaint saved locally but could not sync. Please retry.');
  };

  document.querySelectorAll('[data-l1delcomplaint]').forEach(btn=>{
    btn.onclick = async ()=>{
      if(!confirm('Delete this complaint record?')) return;
      DB.complaints = DB.complaints.filter(c=>c.id!==btn.dataset.l1delcomplaint);
      await save('complaints');
      render();
    };
  });
}

/* ================= NEW ENTRY ================= */
let entryDraft = null;
let editingEntryId = null;
let draftPromptDismissed = false;

/* Draft auto-save: protects unsaved New Entry work against accidental refresh, browser
   crash, or closed tab. Never involves server data — purely a local safety net, scoped
   per logged-in account so a shared terminal can't leak one operator's draft to another. */
function draftStorageKey(){ return SESSION ? ('prf_draft_'+SESSION.id) : null; }
function getSavedDraft(){
  const key = draftStorageKey();
  if(!key) return null;
  try{
    const raw = localStorage.getItem(key);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(parsed.savedAt && (Date.now() - new Date(parsed.savedAt).getTime()) > 24*60*60*1000){
      localStorage.removeItem(key); // stale (>24h) — not worth prompting for
      return null;
    }
    return parsed;
  }catch(e){ return null; }
}
function clearSavedDraft(){
  const key = draftStorageKey();
  if(!key) return;
  try{ localStorage.removeItem(key); }catch(e){}
}

function blankDraft(){
  const defaultSite = DB.sites.find(s=>s.name==='10001');
  return {
    date: todayStr(), shiftId:'', siteId: defaultSite ? defaultSite.id : '', locationId: effectiveLocationId(), machineId:'', itemId:'',
    spm:'', qty:'', weight:'', rejectedQty:'', downtimeBlocks:[], items:[], operatorName: (SESSION && SESSION.name) || '', supervisorId:''
  };
}

function renderOptions(arr, val, placeholder){
  return `<option value="">${placeholder}</option>` + arr.map(o=>`<option value="${o.id}" ${o.id===val?'selected':''}>${o.name}</option>`).join('');
}
function itemLabel(item){
  if(!item) return '';
  return item.itemCode ? `${item.itemCode} — ${item.name}` : item.name;
}
function itemSuggestionsHtml(query){
  const q = query.trim().toLowerCase();
  if(!q) return '';
  const matches = DB.items.filter(it=> itemLabel(it).toLowerCase().includes(q)).slice(0,50);
  if(matches.length===0) return `<div class="item-suggest-empty">No items match "${query}"</div>`;
  return matches.map(it=>`<div class="item-suggest-row" data-itemid="${it.id}">${itemLabel(it)}</div>`).join('');
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
/* Supervisors visible in New Entry: if the current user is location-restricted, only show
   supervisors assigned to that same location, plus any supervisor set to "All Locations"
   (who oversees everywhere). If the current user isn't restricted, show every supervisor. */
function supervisorOptionsForCurrentUser(){
  const myLoc = effectiveLocationId();
  return DB.users.filter(u=>{
    if(u.role !== 'supervisor') return false;
    if(!myLoc) return true;
    return !u.locationId || u.locationId === myLoc;
  });
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

function renderExtraItemsHtml(items){
  if(!items || items.length===0){
    return `<div class="helptext">No additional items yet.</div>`;
  }
  return items.map(it=>{
    const item = byId(DB.items, it.itemId);
    const label = item ? itemLabel(item) : '';
    return `
    <div class="extra-item-row" data-itemrowid="${it.id}" style="display:flex; gap:10px; align-items:flex-end; margin-bottom:14px; flex-wrap:wrap; padding-bottom:10px; border-bottom:1px dashed var(--line);">
      <div class="field item-suggest-wrap" style="flex:1; min-width:200px; margin-bottom:0;"><label>Item</label>
        <input type="text" class="ei-item-search" data-itemrowid="${it.id}" autocomplete="off" placeholder="Type 1+ characters to search..." value="${label}">
        <div class="item-suggest-list ei-item-suggest" data-itemrowid="${it.id}" style="display:none;"></div>
      </div>
      <div class="field" style="min-width:90px; margin-bottom:0;"><label>SPM</label><input type="text" class="ei-spm-display" value="${it.spm||''}" readonly style="opacity:0.7;"></div>
      <div class="field" style="min-width:110px; margin-bottom:0;"><label>Qty</label><input type="number" min="0" class="ei-qty" data-itemrowid="${it.id}" value="${it.qty||''}"></div>
      <div class="field" style="min-width:110px; margin-bottom:0;"><label>Rejected</label><input type="number" min="0" class="ei-rejected" data-itemrowid="${it.id}" value="${it.rejectedQty||''}"></div>
      <div class="field" style="min-width:110px; margin-bottom:0;"><label>Weight (g)</label><input type="text" class="ei-weight-display" value="${it.weight||''}" readonly style="opacity:0.7;"></div>
      <button class="icon-btn danger ei-remove" type="button" data-itemrowid="${it.id}" title="Remove">✕</button>
    </div>`;
  }).join('');
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
  const savedDraft = (!editingEntryId && !draftPromptDismissed) ? getSavedDraft() : null;
  return `
  <div class="page-head">
    <div>
      <div class="page-eyebrow">Production Entry</div>
      <div class="page-title">${editingEntryId ? 'Edit Entry' : 'New Entry'}</div>
    </div>
  </div>
  ${savedDraft ? `
  <div class="banner" style="margin-bottom:18px; justify-content:space-between;">
    <div>⚠ <b>Unsaved entry found</b> from ${new Date(savedDraft.savedAt).toLocaleString()} — looks like a previous session was interrupted before saving. Restore it?</div>
    <div style="display:flex; gap:8px; flex-shrink:0;">
      <button class="btn btn-sm" type="button" id="restoreDraftBtn">Restore</button>
      <button class="btn btn-ghost btn-sm" type="button" id="discardDraftBtn">Discard</button>
    </div>
  </div>` : ''}
  <div class="panel">
    <form id="entryForm">
      <div class="form-row">
        <div class="field"><label>Date</label><input type="date" id="f_date" value="${d.date}" required>
          <div class="helptext">For an overnight shift, use the date it started (e.g. a shift running 18:30–08:30 is dated the evening it began, not the morning it ends).</div>
        </div>
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
        <div class="field item-suggest-wrap"><label>Item</label>
          <div style="display:flex; gap:6px;">
            <input type="text" id="f_item_search" autocomplete="off" placeholder="Type 1+ characters to search item code or name..." value="${d.itemId && byId(DB.items,d.itemId) ? itemLabel(byId(DB.items,d.itemId)) : ''}" style="flex:1;">
            <button type="button" id="f_item_clear" class="icon-btn" title="Clear item search">✕</button>
          </div>
          <select id="f_item" style="display:none;">${renderItemOptions(DB.items, d.itemId, 'Select item')}</select>
          <div class="item-suggest-list" id="f_item_suggest" style="display:none;"></div>
          <div class="helptext">Search any item by code or name — not limited to items already mapped to this machine. SPM auto-fills once you select an item, if a rate exists for this Machine + Item.</div>
        </div>
      </div>
      <div class="form-row">
        <div class="field"><label>Item Code</label><input type="text" id="f_itemcode" value="${(byId(DB.items,d.itemId)||{}).itemCode||''}" readonly style="opacity:0.7;"></div>
        <div class="field" style="grid-column:span 2;"><label>Item Description</label><input type="text" id="f_itemdesc" value="${(byId(DB.items,d.itemId)||{}).description||''}" readonly style="opacity:0.7;"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>SPM (auto from Master Data)</label><input type="number" id="f_spm" value="${d.spm}" readonly style="opacity:0.7;"></div>
        <div class="field"><label>Planned Qty (Working Time × SPM)</label><input type="text" id="plannedQtyDisplay" value="—" readonly style="opacity:0.7;">
          <div class="helptext">Updates once Shift and Down Time entries below are set — check this before entering Qty.</div>
        </div>
      </div>
      <div class="form-row">
        <div class="field"><label>Production Qty</label><input type="number" min="0" id="f_qty" value="${d.qty}" required></div>
        <div class="field"><label>Weight Produced (g, auto from Qty × Weight/Pc)</label><input type="number" id="f_weight" value="${d.weight}" readonly style="opacity:0.7;">
          <div class="helptext">If the item has a Weight/Pc set in Master Data, Weight auto-calculates from Qty.</div>
        </div>
        <div class="field"><label>Rejected Qty (optional)</label><input type="number" min="0" id="f_rejected" value="${d.rejectedQty}"></div>
      </div>

      ${editingEntryId ? '' : `
      <div class="panel-title" style="margin-top:8px; margin-bottom:8px;"><span class="bar"></span>Additional Items (Same Machine, Same Shift)</div>
      <div class="helptext" style="margin-bottom:12px;">If more than one item was run on this machine during this shift (e.g. a setting change partway through), add each one here instead of creating separate entries. Down Time above is logged once for the whole shift.</div>
      <div id="extraItemsContainer">${renderExtraItemsHtml(d.items)}</div>
      <button class="btn btn-ghost btn-sm" type="button" id="addExtraItemBtn" style="margin-top:4px; margin-bottom:18px;">+ Add Another Item</button>
      <div id="multiItemValidationMsg" class="login-err" style="display:none; margin-bottom:18px;"></div>
      `}

      <div class="panel-title" style="margin-top:8px; margin-bottom:12px;"><span class="bar"></span>Down Time Entries</div>
      <div id="dtBlocksContainer">${renderDtBlocksHtml(d.downtimeBlocks)}</div>
      <button class="btn btn-ghost btn-sm" type="button" id="addDtBlockBtn" style="margin-top:4px; margin-bottom:18px;">+ Add Down Time</button>

      <div class="grid-2" style="margin-bottom:18px;">
        <div class="kpi-card"><div class="kpi-label">Total Down Time</div><div class="kpi-value" id="dtTotalDisplay" style="font-size:18px;">0 min</div></div>
        <div class="kpi-card"><div class="kpi-label">Working Time (Shift − Break − Down Time)</div><div class="kpi-value" id="workingTimeDisplay" style="font-size:18px;">—</div></div>
      </div>
      <div id="dtTotalValidationMsg" class="login-err" style="display:none; margin-bottom:12px;"></div>
      <div id="qtyValidationMsg" class="login-err" style="display:none; margin-bottom:18px;"></div>

      <div class="form-row">
        <div class="field"><label>Operator Name</label><input type="text" id="f_operator" value="${d.operatorName}" readonly style="opacity:0.7;">
          <div class="helptext">Auto-filled from your login account.</div>
        </div>
        <div class="field"><label>Supervisor</label><select id="f_supervisor" required>${renderOptions(supervisorOptionsForCurrentUser(), d.supervisorId, 'Select supervisor')}</select></div>
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
  const restoreDraftBtn = document.getElementById('restoreDraftBtn');
  if(restoreDraftBtn) restoreDraftBtn.onclick = ()=>{
    const snap = getSavedDraft();
    if(snap){
      entryDraft = {
        date: snap.date || todayStr(), shiftId: snap.shiftId||'', siteId: snap.siteId||'',
        locationId: snap.locationId||'', machineId: snap.machineId||'', itemId: snap.itemId||'',
        spm: snap.spm||'', qty: snap.qty||'', weight: snap.weight||'', rejectedQty: snap.rejectedQty||'',
        downtimeBlocks: snap.downtimeBlocks||[], items: snap.items||[],
        operatorName: (SESSION && SESSION.name) || '', supervisorId: snap.supervisorId||''
      };
      editingEntryId = null;
    }
    draftPromptDismissed = true;
    render();
  };
  const discardDraftBtn = document.getElementById('discardDraftBtn');
  if(discardDraftBtn) discardDraftBtn.onclick = ()=>{
    clearSavedDraft();
    draftPromptDismissed = true;
    render();
  };

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
  const dtTotalValidationMsg = document.getElementById('dtTotalValidationMsg');

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
  let lastWorkingMinutes = 0;
  let lastDtBlocksValid = true;
  let lastDowntimeExceedsShift = false;

  const extraItemsContainer = document.getElementById('extraItemsContainer');
  const multiItemValidationMsg = document.getElementById('multiItemValidationMsg');

  const recomputeExtraItemRow = (rowId)=>{
    const it = entryDraft.items.find(x=>x.id===rowId);
    if(!it) return;
    const searchEl = extraItemsContainer.querySelector(`.ei-item-search[data-itemrowid="${rowId}"]`);
    const qtyEl = extraItemsContainer.querySelector(`.ei-qty[data-itemrowid="${rowId}"]`);
    const rejEl = extraItemsContainer.querySelector(`.ei-rejected[data-itemrowid="${rowId}"]`);
    const row = searchEl ? searchEl.closest('.extra-item-row') : null;
    const spmDisplay = row ? row.querySelector('.ei-spm-display') : null;
    const weightDisplay = row ? row.querySelector('.ei-weight-display') : null;

    const typed = searchEl ? searchEl.value.trim() : '';
    const matchedItem = DB.items.find(x=>itemLabel(x)===typed);
    it.itemId = matchedItem ? matchedItem.id : '';
    it.qty = qtyEl ? Number(qtyEl.value)||0 : 0;
    it.rejectedQty = rejEl ? Number(rejEl.value)||0 : 0;
    it.spm = matchedItem ? (lookupSpm(machineSel.value, matchedItem.id) || 0) : 0;
    if(spmDisplay) spmDisplay.value = it.spm || '';
    const wpp = matchedItem ? Number(matchedItem.weightPerPiece)||0 : 0;
    it.weight = wpp>0 ? Math.round(it.qty*wpp) : 0;
    if(weightDisplay) weightDisplay.value = it.weight || '';
  };

  const recomputeMultiItemValidation = ()=>{
    if(!multiItemValidationMsg) return true;
    if(entryDraft.items.length === 0){ multiItemValidationMsg.style.display = 'none'; return true; }
    const mainSpm = Number(spmInput.value)||0;
    const mainQty = Number(qtyInput.value)||0;
    const rows = [{spm:mainSpm, qty:mainQty}, ...entryDraft.items.map(it=>({spm:it.spm, qty:it.qty}))];
    let requiredMinutes = 0;
    let anyMissingSpm = false;
    rows.forEach(r=>{
      if(r.qty > 0){
        if(r.spm > 0){ requiredMinutes += r.qty / r.spm; }
        else { anyMissingSpm = true; }
      }
    });
    if(anyMissingSpm){
      multiItemValidationMsg.style.display = '';
      multiItemValidationMsg.textContent = 'One or more additional items have no SPM rate for this machine — ask your Supervisor to add it under SPM before saving.';
      return false;
    }
    const budget = lastWorkingMinutes * 1.2;
    if(entryDraft.items.length > 0 && requiredMinutes > budget){
      multiItemValidationMsg.style.display = '';
      multiItemValidationMsg.textContent = `Combined production across all items needs about ${Math.round(requiredMinutes)} min, which exceeds the allowed 120% of Working Time (${Math.round(budget)} min). Please review quantities.`;
      return false;
    }
    multiItemValidationMsg.style.display = 'none';
    return true;
  };

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
    lastDowntimeExceedsShift = shift ? (total > shiftMinutes) : false;
    if(lastDowntimeExceedsShift){
      dtTotalValidationMsg.style.display = '';
      dtTotalValidationMsg.textContent = `Total Down Time (${total} min) exceeds this shift's Available Time (${shiftMinutes} min). Down time blocks likely overlap — check the From/To times above; overlapping periods shouldn't be counted twice.`;
    } else {
      dtTotalValidationMsg.style.display = 'none';
    }
    const workingMinutes = Math.max(shiftMinutes - total, 0);
    workingTimeDisplay.textContent = shift ? (workingMinutes + ' min') : '—';
    lastWorkingMinutes = workingMinutes;

    const spmVal = Number(spmInput.value)||0;
    const plannedQty = (shift && spmVal) ? Math.round(workingMinutes * spmVal) : 0;
    plannedQtyDisplay.value = plannedQty > 0 ? plannedQty : '—';
    lastPlannedQty = plannedQty;

    validateQty();
    recomputeMultiItemValidation();
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
  shiftSel.onchange = ()=>{
    const shift = byId(DB.shifts, shiftSel.value);
    const dateInput = document.getElementById('f_date');
    if(shift && shift.startTime && dateInput){
      const [sh, sm] = shift.startTime.split(':').map(Number);
      const shiftStartMinOfDay = (sh||0)*60 + (sm||0);
      const crossesMidnight = shiftStartMinOfDay + (Number(shift.durationMinutes)||0) > 24*60;
      const now = new Date();
      const nowMinOfDay = now.getHours()*60 + now.getMinutes();
      // If the current clock time is earlier than this shift's own start time, and the shift
      // runs past midnight, the operator is almost certainly logging the overnight shift that
      // started YESTERDAY evening (e.g. filling the form the next morning near shift-end) —
      // default the Date to yesterday instead of today. Only touches the field while it's
      // still at today's default, so it never overrides a date the operator already set.
      if(crossesMidnight && nowMinOfDay < shiftStartMinOfDay && dateInput.value === todayStr()){
        dateInput.value = yesterdayStr();
      }
    }
    recomputeSummary();
  };
  qtyInput.oninput = ()=>{ updateWeightFromQty(); recomputeSummary(); };

  const itemSearchInput = document.getElementById('f_item_search');
  const itemSuggestBox = document.getElementById('f_item_suggest');
  const chooseMainItem = (itemId)=>{
    const item = byId(DB.items, itemId);
    itemSel.value = itemId;
    itemSearchInput.value = item ? itemLabel(item) : '';
    itemSuggestBox.style.display = 'none';
    updateSpm(); updateItemInfo(); updateWeightFromQty(); recomputeSummary();
  };
  itemSearchInput.oninput = ()=>{
    const q = itemSearchInput.value;
    if(itemSel.value){ itemSel.value=''; updateSpm(); updateItemInfo(); updateWeightFromQty(); recomputeSummary(); }
    if(!q.trim()){ itemSuggestBox.style.display='none'; itemSuggestBox.innerHTML=''; return; }
    itemSuggestBox.innerHTML = itemSuggestionsHtml(q);
    itemSuggestBox.style.display = '';
  };
  itemSearchInput.onfocus = ()=>{
    if(itemSearchInput.value.trim()){ itemSuggestBox.innerHTML = itemSuggestionsHtml(itemSearchInput.value); itemSuggestBox.style.display=''; }
  };
  itemSearchInput.onblur = ()=>{ setTimeout(()=>{ itemSuggestBox.style.display='none'; }, 150); };
  itemSuggestBox.onmousedown = (ev)=>{
    const row = ev.target.closest('.item-suggest-row');
    if(row) chooseMainItem(row.dataset.itemid);
  };
  const itemClearBtn = document.getElementById('f_item_clear');
  if(itemClearBtn) itemClearBtn.onclick = ()=>{
    itemSearchInput.value = '';
    itemSel.value = '';
    itemSuggestBox.style.display = 'none';
    itemSuggestBox.innerHTML = '';
    updateSpm(); updateItemInfo(); updateWeightFromQty(); recomputeSummary();
    itemSearchInput.focus();
  };

  const wireExtraItemTypeaheads = ()=>{
    if(!extraItemsContainer) return;
    extraItemsContainer.querySelectorAll('.ei-item-search').forEach(inputEl=>{
      const rowId = inputEl.dataset.itemrowid;
      const suggestBox = extraItemsContainer.querySelector(`.ei-item-suggest[data-itemrowid="${rowId}"]`);
      if(!suggestBox) return;
      inputEl.oninput = ()=>{
        const q = inputEl.value;
        recomputeExtraItemRow(rowId);
        recomputeMultiItemValidation();
        if(!q.trim()){ suggestBox.style.display='none'; suggestBox.innerHTML=''; return; }
        suggestBox.innerHTML = itemSuggestionsHtml(q);
        suggestBox.style.display = '';
      };
      inputEl.onfocus = ()=>{
        if(inputEl.value.trim()){ suggestBox.innerHTML = itemSuggestionsHtml(inputEl.value); suggestBox.style.display=''; }
      };
      inputEl.onblur = ()=>{ setTimeout(()=>{ suggestBox.style.display='none'; }, 150); };
      suggestBox.onmousedown = (ev)=>{
        const row = ev.target.closest('.item-suggest-row');
        if(!row) return;
        const item = byId(DB.items, row.dataset.itemid);
        if(item){
          inputEl.value = itemLabel(item);
          suggestBox.style.display = 'none';
          recomputeExtraItemRow(rowId);
          recomputeMultiItemValidation();
        }
      };
    });
  };

  if(extraItemsContainer){
    extraItemsContainer.oninput = (ev)=>{
      if(ev.target.classList.contains('ei-item-search')) return; // handled by its own typeahead wiring above
      const rowId = ev.target.dataset.itemrowid;
      if(rowId){ recomputeExtraItemRow(rowId); recomputeMultiItemValidation(); }
    };
    extraItemsContainer.onchange = (ev)=>{
      if(ev.target.classList.contains('ei-item-search')) return;
      const rowId = ev.target.dataset.itemrowid;
      if(rowId){ recomputeExtraItemRow(rowId); recomputeMultiItemValidation(); }
    };
    extraItemsContainer.onclick = (ev)=>{
      const btn = ev.target.closest('.ei-remove');
      if(!btn) return;
      entryDraft.items = entryDraft.items.filter(x=>x.id!==btn.dataset.itemrowid);
      extraItemsContainer.innerHTML = renderExtraItemsHtml(entryDraft.items);
      wireExtraItemTypeaheads();
      recomputeMultiItemValidation();
    };
    wireExtraItemTypeaheads();
  }
  const addExtraItemBtn = document.getElementById('addExtraItemBtn');
  if(addExtraItemBtn){
    addExtraItemBtn.onclick = ()=>{
      entryDraft.items.push({id: uid('ei'), itemId:'', qty:0, rejectedQty:0, spm:0, weight:0});
      extraItemsContainer.innerHTML = renderExtraItemsHtml(entryDraft.items);
      wireExtraItemTypeaheads();
    };
  }

  locationSel.onchange = ()=>{
    machineSel.innerHTML = renderMachineOptions(machinesForLocation(locationSel.value), '', 'Select machine');
    spmInput.value = '';
    updateSpm();
    recomputeSummary();
  };
  machineSel.onchange = ()=>{
    spmInput.value = '';
    updateSpm();
    entryDraft.items.forEach(it=>recomputeExtraItemRow(it.id));
    recomputeSummary();
  };

  recomputeSummary(); // initialize on load (handles edit mode with pre-filled blocks)

  // ---- Draft auto-save: persist in-progress form state locally as the operator types ----
  const entryFormEl = document.getElementById('entryForm');
  let draftSaveTimer = null;
  const persistDraft = ()=>{
    if(editingEntryId || !SESSION) return; // never persist while editing an existing entry
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(()=>{
      const snap = {
        date: document.getElementById('f_date').value,
        shiftId: document.getElementById('f_shift').value,
        siteId: document.getElementById('f_site').value,
        locationId: document.getElementById('f_location').value,
        machineId: machineSel.value,
        itemId: itemSel.value,
        spm: spmInput.value,
        qty: qtyInput.value,
        weight: weightInput.value,
        rejectedQty: document.getElementById('f_rejected').value,
        supervisorId: document.getElementById('f_supervisor').value,
        downtimeBlocks: entryDraft.downtimeBlocks,
        items: entryDraft.items,
        savedAt: new Date().toISOString()
      };
      const hasContent = snap.machineId || snap.itemId || Number(snap.qty)>0 || snap.downtimeBlocks.length>0 || snap.items.length>0;
      const key = draftStorageKey();
      if(!key) return;
      try{
        if(hasContent) localStorage.setItem(key, JSON.stringify(snap));
        else localStorage.removeItem(key);
      }catch(e){}
    }, 500);
  };
  if(entryFormEl){
    entryFormEl.addEventListener('input', persistDraft);
    entryFormEl.addEventListener('change', persistDraft);
  }

  document.getElementById('clearEntryForm').onclick = ()=>{ entryDraft = blankDraft(); editingEntryId=null; clearSavedDraft(); render(); };

  document.getElementById('entryForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    if(!itemSel.value){ alert('Please select an item using the search box before saving.'); return; }
    const spmVal = spmInput.value;
    if(!spmVal){ alert('No SPM found for this Machine + Item combination. Please add it under Master Data → SPM first.'); return; }
    const summary = recomputeSummary();
    if(!lastDtBlocksValid){
      alert('One or more Down Time entries fall outside the selected shift\'s time window. Please fix the times highlighted in red before saving.');
      return;
    }
    if(lastDowntimeExceedsShift){
      alert(dtTotalValidationMsg.textContent);
      return;
    }
    if(!validateQty()){
      alert(qtyValidationMsg.textContent);
      return;
    }
    // Validate any additional item rows: must have a matched item and a valid SPM before saving
    const validExtraItems = entryDraft.items.filter(it=>it.itemId && it.qty>0);
    const incompleteExtraRow = entryDraft.items.some(it=>(it.itemId||it.qty>0) && (!it.itemId || it.qty<=0));
    if(incompleteExtraRow){
      alert('One of the Additional Item rows is incomplete — each row needs both an item selected and a Qty greater than 0. Remove any unused rows before saving.');
      return;
    }
    const missingExtraSpm = validExtraItems.some(it=>!(it.spm>0));
    if(missingExtraSpm){
      alert('One or more additional items have no SPM rate for this Machine + Item combination. Please add it under Master Data → SPM first, or remove that row.');
      return;
    }
    if(!recomputeMultiItemValidation()){
      alert(multiItemValidationMsg.textContent);
      return;
    }

    const existing = editingEntryId ? DB.entries.find(e=>e.id===editingEntryId) : null;
    const sharedFields = {
      date: document.getElementById('f_date').value,
      shiftId: document.getElementById('f_shift').value,
      siteId: document.getElementById('f_site').value,
      locationId: document.getElementById('f_location').value,
      machineId: machineSel.value,
      operatorName: existing ? existing.operatorName : SESSION.name,
      supervisorId: document.getElementById('f_supervisor').value,
      supervisorName: nameOf(DB.users, document.getElementById('f_supervisor').value),
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      lastEditedBy: existing ? SESSION.id : undefined,
      lastEditedByName: existing ? SESSION.name : undefined,
      lastEditedAt: existing ? new Date().toISOString() : undefined
    };
    const batchId = (validExtraItems.length > 0 && !editingEntryId) ? uid('batch') : (existing ? existing.batchId : undefined);

    const mainRec = {
      id: editingEntryId || uid('en'),
      ...sharedFields,
      itemId: itemSel.value,
      spm: Number(spmVal),
      qty: Number(document.getElementById('f_qty').value)||0,
      weight: Number(document.getElementById('f_weight').value)||0,
      rejectedQty: Number(document.getElementById('f_rejected').value)||0,
      downtimeMinutes: summary.total,
      downtimeBlocks: entryDraft.downtimeBlocks.map(b=>({reasonId:b.reasonId, from:b.from, to:b.to, minutes:b.minutes})),
      batchId
    };

    const newRecs = [mainRec];
    validExtraItems.forEach(it=>{
      newRecs.push({
        id: uid('en'),
        ...sharedFields,
        itemId: it.itemId,
        spm: it.spm,
        qty: it.qty,
        weight: it.weight,
        rejectedQty: it.rejectedQty,
        // Down time is logged once for the whole shift, attached only to the first item
        // in the batch — every other item in this batch carries no down time of its own,
        // so shift-level down time is never double-counted in aggregate totals.
        downtimeMinutes: 0,
        downtimeBlocks: [],
        batchId
      });
    });

    if(editingEntryId){
      const idx = DB.entries.findIndex(e=>e.id===editingEntryId);
      if(idx>=0) DB.entries[idx] = mainRec;
    } else {
      newRecs.forEach(r=>DB.entries.push(r));
    }
    let ok;
    if(editingEntryId){
      ok = await updateEntryRow(mainRec);
    } else {
      ok = await insertEntries(newRecs);
    }
    entryDraft = blankDraft(); editingEntryId = null; clearSavedDraft();
    ROUTE = 'entrylog';
    render();
    if(!ok) alert('Warning: entry saved locally but could not sync to shared storage. Please retry — your other entries and other users\' data are unaffected either way.');
    else if(newRecs.length > 1) alert(`Saved ${newRecs.length} linked entries for this shift (${newRecs.length} items total).`);
  };
}

/* ================= ENTRY LOG ================= */
let logFilters = { start:'', end:'', machineId:'', shiftId:'', siteId:'', search:'' };

function pageEntryLog(){
  let rows = DB.entries.slice().sort((a,b)=> (b.date+b.createdAt).localeCompare(a.date+a.createdAt));
  if(effectiveLocationId()) rows = rows.filter(e=>e.locationId===effectiveLocationId());
  // Operators only ever see their own entries from today or yesterday — never other
  // operators' work, and never older history. This is a hard cap: their own filter
  // choices below can narrow it further, but can never widen past this.
  if(SESSION.role === 'operator'){
    const today = todayStr(), yesterday = yesterdayStr();
    rows = rows.filter(e => (e.date === today || e.date === yesterday) && e.operatorName === SESSION.name);
  }
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
    ${SESSION.role==='operator' ? `<div class="helptext" style="margin-bottom:14px; padding:10px; border:1px dashed var(--line); border-radius:4px;">You're viewing only <b style="color:var(--ink);">your own entries from today and yesterday</b>. For anything older, or to see other operators' entries, ask your Supervisor.</div>` : ''}
    <div class="filter-bar">
      <div class="field" style="min-width:220px;"><label>Search</label><input type="text" id="lf_search" placeholder="Operator, item, machine, code..." value="${logFilters.search}"></div>
      <div class="field"><label>From</label><input type="date" id="lf_start" value="${logFilters.start}"></div>
      <div class="field"><label>To</label><input type="date" id="lf_end" value="${logFilters.end}"></div>
      <div class="field"><label>Machine</label><select id="lf_machine"><option value="">All</option>${DB.machines.map(m=>`<option value="${m.id}" ${logFilters.machineId===m.id?'selected':''}>${m.name}</option>`).join('')}</select></div>
      <div class="field"><label>Shift</label><select id="lf_shift"><option value="">All</option>${DB.shifts.map(m=>`<option value="${m.id}" ${logFilters.shiftId===m.id?'selected':''}>${m.name}</option>`).join('')}</select></div>
      <div class="field"><label>Site</label><select id="lf_site"><option value="">All</option>${DB.sites.map(m=>`<option value="${m.id}" ${logFilters.siteId===m.id?'selected':''}>${m.name}</option>`).join('')}</select></div>
      <button class="btn btn-ghost btn-sm" id="lf_clear" type="button">Clear Filters</button>
    </div>
    <div style="font-size:12.5px; color:var(--ink-dim); margin-bottom:14px;">
      <b style="color:var(--amber);">${rows.length}</b> entr${rows.length===1?'y':'ies'} found${rows.length>0 ? ` · <b style="color:var(--ink);">${rows.reduce((s,e)=>s+(Number(e.qty)||0),0).toLocaleString()}</b> pcs total` : ''}
    </div>
    <div class="table-scroll">
      <table>
        <thead><tr>
          <th>Date</th><th>Shift</th><th>Site</th><th>Location</th><th>Machine Code</th><th>Machine</th><th>Item Code</th><th>Item</th>
          <th>SPM</th><th>Weight (kg)</th><th>Qty</th><th>Rej.</th><th>D/T Min</th><th>Reason</th><th>Operator</th><th>Supervisor</th><th></th>
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
              <td style="font-family:var(--mono);">${entryWeightGrams(e)>0 ? fmt1(entryWeightGrams(e)/1000) : '—'}</td>
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
      entryDraft.items = []; // Additional Items only applies to new entries, not edits
      editingEntryId = rec.id;
      ROUTE='newentry'; render();
    };
  });
  document.querySelectorAll('[data-del]').forEach(btn=>{
    btn.onclick = async ()=>{
      if(!confirm('Delete this entry? This cannot be undone.')) return;
      const idToDelete = btn.dataset.del;
      DB.entries = DB.entries.filter(x=>x.id!==idToDelete);
      await deleteEntryRow(idToDelete);
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
  {key:'invoices', label:'Invoices'},
  {key:'plantmetrics', label:'Plant Metrics'},
  {key:'complaints', label:'Customer Complaints'},
  {key:'users', label:'Supervisor Accounts'},
];
/* Marketing role only manages Invoices and Customer Complaints — everything else in
   Master Data (production config, Danger Zone, Accounts) stays Admin-only. */
function mdTabsForRole(){
  if(SESSION && SESSION.role === 'marketing') return MD_TABS.filter(t=>t.key==='invoices' || t.key==='complaints');
  return MD_TABS;
}

function pageSpmOnly(){
  mdTab = 'spm'; // ensures shared master-data logic (import/export/search) targets the SPM tab
  return `
  <div class="page-head">
    <div>
      <div class="page-eyebrow">Configuration</div>
      <div class="page-title">SPM Rates</div>
    </div>
  </div>
  <div class="panel">
    ${spmEditor()}
  </div>
  `;
}

function pageMasterData(){
  const isAdmin = SESSION.role === 'admin';
  const allowedTabKeys = mdTabsForRole().map(t=>t.key);
  if(!allowedTabKeys.includes(mdTab)) mdTab = allowedTabKeys[0];
  return `
  <div class="page-head">
    <div>
      <div class="page-eyebrow">Configuration</div>
      <div class="page-title">Master Data</div>
    </div>
  </div>
  <div class="panel">
    <div class="tabs">
      ${mdTabsForRole().map(t=>`<button class="tab-btn ${mdTab===t.key?'active':''}" data-tab="${t.key}">${t.label}</button>`).join('')}
    </div>
    <div id="mdBody">${renderMdTab()}</div>
  </div>
  ${isAdmin ? `
  <div class="panel" style="margin-top:18px; border-color:var(--red);">
    <div class="panel-title" style="color:var(--red);"><span class="bar" style="background:var(--red);"></span>Danger Zone</div>
    <p class="helptext" style="margin-bottom:14px;">Before going live, clear all test/UAT production entries while keeping every Master Data setup (machines, items, SPM, locations, sites, shifts, reasons, accounts) untouched. Entries will start fresh from zero. This cannot be undone.</p>
    <button class="btn btn-danger btn-sm" id="clearEntriesBtn" type="button">Clear All Entries (keep Master Data)</button>
  </div>` : ''}
  `;
}

function renderMdTab(){
  if(mdTab==='machines') return simpleListEditor('machines', [{key:'name',label:'Machine Name'},{key:'machineCode',label:'Machine Code'},{key:'site',label:'Site',type:'select',options:DB.sites},{key:'location',label:'Location',type:'select',options:DB.locations}]);
  if(mdTab==='items') return weightFixBlock() + simpleListEditor('items', [{key:'name',label:'Item Name'},{key:'itemCode',label:'Item Code'},{key:'description',label:'Description'},{key:'weightPerPiece',label:'Weight/Pc (g)',type:'number'}]);
  if(mdTab==='locations') return simpleListEditor('locations', [{key:'name',label:'Location Name'}]);
  if(mdTab==='sites') return simpleListEditor('sites', [{key:'name',label:'Site Name'}]);
  if(mdTab==='shifts') return simpleListEditor('shifts', [{key:'name',label:'Shift Name'},{key:'startTime',label:'Start Time',type:'time'},{key:'durationMinutes',label:'Duration (min)',type:'number'},{key:'breakMinutes',label:'Break (min)',type:'number'}]);
  if(mdTab==='reasons') return simpleListEditor('reasons', [{key:'name',label:'Reason'}]);
  if(mdTab==='invoices') return simpleListEditor('invoices', PARTY_TYPE_FIELDS_INVOICE);
  if(mdTab==='plantmetrics') return simpleListEditor('plantmetrics', PLANT_METRICS_FIELDS);
  if(mdTab==='complaints') return simpleListEditor('complaints', COMPLAINT_FIELDS);
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
    if(f.type==='number') return '100';
    if(f.type==='date') return todayStr();
    if(f.type==='time') return '08:00';
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

const APPEND_ONLY_TABS = ['invoices','complaints']; // transaction logs — every row is a new record, never matched/updated by an existing one

const PARTY_TYPE_OPTIONS = [{id:'Domestic',name:'Domestic'},{id:'Export',name:'Export'}];
const PARTY_TYPE_FIELDS_INVOICE = [
  {key:'date',label:'Date',type:'date'},
  {key:'partyName',label:'Party Name'},
  {key:'partyType',label:'Party Type',type:'select',options:PARTY_TYPE_OPTIONS},
  {key:'qty',label:'Qty',type:'number'},
  {key:'wt',label:'Weight (kg)',type:'number'},
  {key:'value',label:'Value (₹, net of tax)',type:'number'}
];
const PLANT_METRICS_FIELDS = [
  {key:'date',label:'Date',type:'date'},
  {key:'cnc1Oee',label:'CNC1 OEE %',type:'number'},
  {key:'cnc1Nos',label:'CNC1 Nos.',type:'number'},
  {key:'cnc2Oee',label:'CNC2 OEE %',type:'number'},
  {key:'cnc2Nos',label:'CNC2 Nos.',type:'number'},
  {key:'finishedGoodsMt',label:'Finished Goods (MT)',type:'number'},
  {key:'dispatchQty',label:'Dispatch Qty',type:'number'},
  {key:'dispatchMt',label:'Dispatch (MT)',type:'number'}
];
const COMPLAINT_FIELDS = [
  {key:'date',label:'Date',type:'date'},
  {key:'customerName',label:'Customer Name'},
  {key:'remark',label:'Remark'}
];

function wireCsvImport(dbKey, fields){
  const input = document.getElementById('csvImport_'+dbKey);
  if(!input) return;
  input.onchange = async (ev)=>{
    const file = ev.target.files[0];
    if(!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    const primaryKey = fields[0].key;
    const appendOnly = APPEND_ONLY_TABS.includes(dbKey);
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
      if(bad || !draft[primaryKey]){ skippedBad++; return; }
      const existing = !appendOnly && DB[dbKey].find(x=>x[primaryKey] && String(x[primaryKey]).toLowerCase()===String(draft[primaryKey]).toLowerCase());
      if(existing){
        Object.assign(existing, draft); // update fields on the matched record, keep its id
        updated++;
      } else {
        DB[dbKey].push({id: uid(dbKey.slice(0,3)), ...draft});
        added++;
      }
    });
    if(added>0 || updated>0) await save(dbKey);
    alert(`Import finished: ${added} added, ${updated} updated (matched by ${fields[0].label}), ${skippedBad} skipped (missing ${fields[0].label} or unmatched reference).`);
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
      if(!['operator','supervisor','head','management','marketing','admin'].includes(role)) role = '';
      const locName = (row['location']||'').trim();
      const location = locName ? DB.locations.find(l=>l.name.toLowerCase()===locName.toLowerCase()) : null;
      const password = row['password']||'';
      const secQ = (row['securityquestion']||'').trim();
      const secA = (row['securityanswer']||'').trim();
      const dashRaw = (row['canaccessdashboard']||'').trim().toLowerCase();
      const canDash = ['yes','true','1','y'].includes(dashRaw);
      const l1Raw = (row['canaccessl1']||'').trim().toLowerCase();
      const canL1 = ['yes','true','1','y'].includes(l1Raw);
      if(!id || !name || !role){ skipped++; continue; }
      const existing = DB.users.find(u=>u.id.toLowerCase()===id.toLowerCase());
      if(existing){
        existing.name = name;
        existing.role = role;
        if(locName){ existing.locationId = location ? location.id : existing.locationId; }
        else { existing.locationId = ''; }
        if(dashRaw) existing.canAccessDashboard = canDash;
        if(l1Raw) existing.canAccessL1 = canL1;
        if(password) existing.passwordHash = await sha256(password);
        if(secQ){ existing.securityQ = secQ; if(secA) existing.securityAHash = await sha256(secA.toLowerCase()); }
        updated++;
      } else {
        if(!password){ skipped++; continue; }
        const passwordHash = await sha256(password);
        const securityAHash = secA ? await sha256(secA.toLowerCase()) : await sha256('not set');
        DB.users.push({
          id, name, role, locationId: location ? location.id : '', canAccessDashboard: canDash, canAccessL1: canL1,
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

function downloadCsv(lines, filename){
  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportListCsv(dbKey, fields){
  const header = fields.map(f=>f.label);
  const lines = [header.join(',')];
  DB[dbKey].forEach(item=>{
    const row = fields.map(f=>{
      if(f.type==='select') return nameOf(f.options, item[f.key]);
      return (item[f.key]!==undefined && item[f.key]!==null) ? item[f.key] : '';
    });
    lines.push(row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
  });
  downloadCsv(lines, `prf-${dbKey}-${todayStr()}.csv`);
}

function exportSpmCsv(){
  const header = ['MachineCode','ItemCode','SPM'];
  const lines = [header.join(',')];
  DB.spm.forEach(s=>{
    lines.push([machineCodeOf(s.machineId), itemCodeOf(s.itemId), s.spm].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
  });
  downloadCsv(lines, `prf-spm-${todayStr()}.csv`);
}

function exportUsersCsv(){
  const header = ['UserID','FullName','Role','Location','CanAccessDashboard','CanAccessL1','SecurityQuestion'];
  const lines = [header.join(',')];
  DB.users.forEach(u=>{
    const autoDash = u.role==='admin' || u.role==='head' || u.role==='management';
    const dashVal = autoDash ? 'auto' : (u.canAccessDashboard ? 'yes' : 'no');
    const autoL1 = u.role==='admin' || u.role==='marketing';
    const l1Val = autoL1 ? 'auto' : (u.canAccessL1 ? 'yes' : 'no');
    lines.push([
      u.id, u.name, u.role, u.locationId ? nameOf(DB.locations,u.locationId) : 'All', dashVal, l1Val, u.securityQ||''
    ].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
  });
  downloadCsv(lines, `prf-accounts-${todayStr()}.csv`);
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
    ${DB[dbKey].length>0 ? `<button class="btn btn-ghost btn-sm" id="exportListBtn" data-exportlist="${dbKey}" type="button">Export ${MD_TABS.find(t=>t.key===mdTab).label} (CSV)</button>` : ''}
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
    ${DB.spm.length>0 ? `<button class="btn btn-ghost btn-sm" id="exportSpmBtn" type="button">Export SPM (CSV)</button>` : ''}
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
  const csvTemplate = 'userid,fullname,role,location,canaccessdashboard,canaccessl1,password,securityquestion,securityanswer\nop01,Ramesh Kumar,operator,' + (DB.locations[0]?DB.locations[0].name:'PRF-I') + ',no,no,Temp@123,What is your favorite tool?,Hammer';
  const dataUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvTemplate);
  return `
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px; flex-wrap:wrap; padding:12px; border:1px dashed var(--line); border-radius:4px;">
    <label class="btn btn-ghost btn-sm" style="cursor:pointer; margin:0;">
      Import CSV
      <input type="file" accept=".csv" id="csvImport_users" style="display:none;">
    </label>
    <a href="${dataUri}" download="accounts_template.csv" class="link-btn">Download template (columns: userid,fullname,role,location,canaccessdashboard,canaccessl1,password,securityquestion,securityanswer — role must be operator/supervisor/head/management/marketing/admin, location must match an existing Location name (blank = all locations), canaccessdashboard and canaccessl1 are yes/no)</a>
  </div>
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px; flex-wrap:wrap;">
    <button class="btn btn-sm" id="addUserBtn" type="button">+ Add Supervisor Account</button>
    <button class="btn btn-ghost btn-sm" id="exportUsersBtn" type="button">Export Accounts Report (CSV)</button>
  </div>
  <div class="field" style="max-width:320px; margin-bottom:16px;"><label>Search</label><input type="text" id="mdSearchInput" placeholder="Search by ID or name..." value="${mdSearch}"></div>
  <div class="table-scroll">
    <table>
      <thead><tr><th>User ID</th><th>Name</th><th>Role</th><th>Location</th><th>Dashboard</th><th>Executive</th><th></th></tr></thead>
      <tbody>
      ${list.length===0 ? `<tr class="empty-row"><td colspan="7">${mdSearch.trim() ? 'No matches found.' : 'No accounts yet.'}</td></tr>` :
        list.map(u=>{
          const autoDash = u.role==='admin' || u.role==='head' || u.role==='management';
          const dashCell = autoDash
            ? '<span style="color:var(--ink-dim);">Auto (role)</span>'
            : (u.canAccessDashboard ? '<span style="color:var(--green);">✓ Granted</span>' : '<span style="color:var(--ink-dim);">—</span>');
          const autoL1 = u.role==='admin' || u.role==='marketing';
          const l1Cell = autoL1
            ? '<span style="color:var(--ink-dim);">Auto (role)</span>'
            : (u.canAccessL1 ? '<span style="color:var(--green);">✓ Granted</span>' : '<span style="color:var(--ink-dim);">—</span>');
          return `
        <tr>
          <td style="font-family:var(--mono);">${u.id}</td>
          <td>${u.name}</td>
          <td><span class="tag ${u.role==='admin'?'tag-role-admin':u.role==='operator'?'tag-role-operator':u.role==='head'?'tag-role-head':u.role==='management'?'tag-role-management':u.role==='marketing'?'tag-role-marketing':''}">${u.role}</span></td>
          <td>${u.locationId ? nameOf(DB.locations,u.locationId) : '<span style="color:var(--ink-dim);">All</span>'}</td>
          <td>${dashCell}</td>
          <td>${l1Cell}</td>
          <td>
            <div class="row-actions">
              <button class="icon-btn" data-editaccount="${u.id}" title="Edit Details">✎</button>
              <button class="icon-btn" data-assignloc="${u.id}" title="Assign Location">📍</button>
              <button class="icon-btn" data-changerole="${u.id}" title="Change Role">⇄</button>
              <button class="icon-btn" data-resetpw="${u.id}" title="Reset Password">⟲</button>
              ${u.id!==SESSION.id ? `<button class="icon-btn danger" data-deluser="${u.id}" title="Delete">✕</button>` : ''}
            </div>
          </td>
        </tr>`;}).join('')}
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
    reasons:[{key:'name',label:'Reason'}],
    invoices: PARTY_TYPE_FIELDS_INVOICE,
    plantmetrics: PLANT_METRICS_FIELDS,
    complaints: COMPLAINT_FIELDS
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
    if(!draft[fields[0].key]){ alert(`${fields[0].label} is required`); return; }
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

  const exportListBtn = document.getElementById('exportListBtn');
  if(exportListBtn) exportListBtn.onclick = ()=>{
    const dbKey = exportListBtn.dataset.exportlist;
    if(fieldsMap[dbKey]) exportListCsv(dbKey, fieldsMap[dbKey]);
  };
  const exportSpmBtn = document.getElementById('exportSpmBtn');
  if(exportSpmBtn) exportSpmBtn.onclick = exportSpmCsv;

  document.querySelectorAll('[data-resetpw]').forEach(btn=>{
    btn.onclick = ()=>{ showModal(resetPwModal(btn.dataset.resetpw)); attachResetPwModalEvents(btn.dataset.resetpw); };
  });
  document.querySelectorAll('[data-editaccount]').forEach(btn=>{
    btn.onclick = ()=>{ showModal(editAccountModal(btn.dataset.editaccount)); attachEditAccountModalEvents(btn.dataset.editaccount); };
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
      <div class="field"><label>Role</label><select id="nu_role"><option value="operator">Operator</option><option value="supervisor">Supervisor</option><option value="head">Department Head</option><option value="management">Management</option><option value="marketing">Marketing</option><option value="admin">Admin</option></select>
        <div class="helptext">Operator: submit entries only. Supervisor: full edit/delete on any entry. Department Head: Supervisor rights + Reports + all locations, but no Master Data. Management: view-only Dashboard, Entry Log &amp; Reports across all locations — can't submit entries or edit Master Data. Marketing: manages Invoices &amp; Customer Complaints, sees the Executive Dashboard. Admin: full access.</div>
      </div>
      <div class="field"><label>Assigned Location</label>
        <select id="nu_location">
          <option value="">All Locations (no restriction)</option>
          ${DB.locations.map(l=>`<option value="${l.id}">${l.name}</option>`).join('')}
        </select>
        <div class="helptext">If set, this person only sees and submits entries for that one location — locked on New Entry, filtered in Entry Log and Dashboard.</div>
      </div>
      <div class="field">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="nu_dashboard" style="width:auto;">
          <span>Grant Dashboard Access</span>
        </label>
        <div class="helptext">Only relevant for Operator/Supervisor roles — Admin, Department Head, and Management already have Dashboard access automatically. Check this to let a specific Operator or Supervisor view the Dashboard too.</div>
      </div>
      <div class="field">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="nu_l1" style="width:auto;">
          <span>Grant Executive Dashboard Access</span>
        </label>
        <div class="helptext">For Directors/senior leadership who need the Revenue, Top Customers, Plant Performance &amp; Complaints view. Admin and Marketing already have it automatically.</div>
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
      canAccessDashboard: document.getElementById('nu_dashboard').checked,
      canAccessL1: document.getElementById('nu_l1').checked,
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
    {key:'management', label:'Management — view-only Dashboard, Entry Log & Reports, no entries or Master Data'},
    {key:'marketing', label:'Marketing — manages Invoices & Customer Complaints, sees Executive Dashboard'},
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

function editAccountModal(userId){
  const user = DB.users.find(u=>u.id===userId);
  const presetQuestions = [
    "What is your favorite tool?",
    "What was the name of your first machine you operated?",
    "What is your mother's maiden name?",
    "What was the name of your first pet?",
    "What city were you born in?",
    "What is your favorite color?",
    "What was your childhood nickname?"
  ];
  const isPreset = presetQuestions.includes(user.securityQ);
  return `
    <div class="modal-title">Edit Account Details</div>
    <p class="helptext" style="margin-bottom:14px;">User ID <b style="color:var(--ink);">${userId}</b> cannot be changed (it's the login ID and is referenced by past entries), but you can correct anything else here.</p>
    <form id="editAccountForm">
      <div class="field"><label>Full Name</label><input type="text" id="ea_name" value="${user.name}" required></div>
      <div class="field"><label>Security Question</label>
        <select id="ea_sq_select">
          ${presetQuestions.map(q=>`<option value="${q}" ${q===user.securityQ?'selected':''}>${q}</option>`).join('')}
          <option value="__custom__" ${!isPreset?'selected':''}>Other (write my own)</option>
        </select>
      </div>
      <div class="field" id="ea_sq_custom_wrap" style="${isPreset?'display:none;':''}">
        <label>Custom Security Question</label>
        <input type="text" id="ea_sq_custom" value="${!isPreset?user.securityQ:''}" placeholder="Type your own question">
      </div>
      <div class="field"><label>Security Answer (leave blank to keep unchanged)</label><input type="text" id="ea_sa" placeholder="Only fill in to change the answer"></div>
      <div class="field">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="ea_dashboard" ${user.canAccessDashboard===true?'checked':''} style="width:auto;">
          <span>Grant Dashboard Access</span>
        </label>
        <div class="helptext">Only relevant for Operator/Supervisor roles — Admin, Department Head, and Management already have Dashboard access automatically.</div>
      </div>
      <div class="field">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="ea_l1" ${user.canAccessL1===true?'checked':''} style="width:auto;">
          <span>Grant Executive Dashboard Access</span>
        </label>
        <div class="helptext">Admin and Marketing already have this automatically — use this to grant a specific Director or senior leader access.</div>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">Save Changes</button>
        <button class="btn btn-ghost" type="button" id="cancelEditAccountModal">Cancel</button>
      </div>
    </form>`;
}
function attachEditAccountModalEvents(userId){
  document.getElementById('cancelEditAccountModal').onclick = closeModal;
  const sqSelect = document.getElementById('ea_sq_select');
  const sqCustomWrap = document.getElementById('ea_sq_custom_wrap');
  const sqCustomInput = document.getElementById('ea_sq_custom');
  sqSelect.onchange = ()=>{
    const isCustom = sqSelect.value === '__custom__';
    sqCustomWrap.style.display = isCustom ? '' : 'none';
    if(isCustom) sqCustomInput.focus();
  };
  document.getElementById('editAccountForm').onsubmit = async (ev)=>{
    ev.preventDefault();
    const user = DB.users.find(u=>u.id===userId);
    const newName = document.getElementById('ea_name').value.trim();
    if(!newName){ alert('Full Name is required.'); return; }
    const selectedQ = sqSelect.value;
    const securityQ = selectedQ === '__custom__' ? sqCustomInput.value.trim() : selectedQ;
    if(!securityQ){ alert('Please select or write a security question.'); return; }
    user.name = newName;
    user.securityQ = securityQ;
    user.canAccessDashboard = document.getElementById('ea_dashboard').checked;
    user.canAccessL1 = document.getElementById('ea_l1').checked;
    const newAnswer = document.getElementById('ea_sa').value.trim();
    if(newAnswer){ user.securityAHash = await sha256(newAnswer.toLowerCase()); }
    await save('users');
    closeModal();
    if(userId === SESSION.id){ SESSION.name = newName; SESSION.canAccessDashboard = user.canAccessDashboard; SESSION.canAccessL1 = user.canAccessL1; }
    render();
    alert('Account details updated for ' + userId + '.');
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
    const ok = await deleteAllEntriesTable();
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
      <div class="kpi-card"><div class="kpi-label">Total Weight</div><div class="kpi-value" style="font-size:18px;">${fmt1(agg.totalWeightKg)} kg</div><div style="font-size:12px;font-family:var(--mono);color:var(--ink-dim);margin-top:2px;">${fmt3(agg.totalWeightKg/1000)} MT</div></div>
    </div>

    <div class="panel-title" style="margin-bottom:10px;"><span class="bar"></span>Machine Performance Summary</div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Machine</th><th>Planned Qty</th><th>Actual Qty</th><th>Weight</th><th>OEE %</th><th>Losses (Reason: Minutes)</th></tr></thead>
        <tbody>
          ${machineRows.length===0 ? `<tr class="empty-row"><td colspan="6">No data in this range.</td></tr>` :
            machineRows.map(r=>`
              <tr>
                <td title="${nameOf(DB.machines,r.mid)}">${machineLabel(r.mid)}</td>
                <td style="font-family:var(--mono);">${r.plannedQty}</td>
                <td style="font-family:var(--mono);">${r.actualQty}</td>
                <td style="font-family:var(--mono); white-space:nowrap;">${fmt1(r.weightKg)} kg <span style="color:var(--ink-dim); font-size:11.5px;">(${fmt3(r.weightKg/1000)} MT)</span></td>
                <td style="font-family:var(--mono);color:${kpiColor(r.oeePct)};">${fmt1(r.oeePct)}%</td>
                <td style="font-size:12.5px;color:var(--ink-dim);">${r.lossHtml}</td>
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
    const header = ['Date','Shift','Site','Location','MachineCode','Machine','ItemCode','Item','ItemDescription','SPM','WeightKg','Qty','Rejected','DowntimeMin','Reason','Operator','Supervisor','LastEditedBy','LastEditedAt','OeePct','DowntimePct'];
    const lines = [header.join(',')];
    rows.forEach(r=>{
      const c = entryCalc(r);
      const itemRec = byId(DB.items, r.itemId) || {};
      const machineRec = byId(DB.machines, r.machineId) || {};
      lines.push([
        r.date, nameOf(DB.shifts,r.shiftId), nameOf(DB.sites,r.siteId), nameOf(DB.locations,r.locationId),
        machineRec.machineCode||'', nameOf(DB.machines,r.machineId), itemRec.itemCode||'', nameOf(DB.items,r.itemId), itemRec.description||'', r.spm, fmt1(entryWeightGrams(r)/1000), r.qty, r.rejectedQty||0,
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
    try{ sessionStorage.removeItem('prf_session_userid'); }catch(e){}
    SESSION = null;
    LOGIN_MODE = 'login';
    LOGIN_ERR = 'You were signed out automatically after a period of inactivity.';
    entryDraft = null;
    editingEntryId = null;
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
  // Restore an existing login after a page refresh (sessionStorage clears when the tab
  // actually closes, so this doesn't weaken the shared-terminal auto-logout protection).
  try{
    const savedId = sessionStorage.getItem('prf_session_userid');
    if(savedId){
      const user = DB.users.find(u=>u.id===savedId);
      const userHasDashboard = user && (user.role==='admin' || user.role==='head' || user.role==='management' || user.canAccessDashboard===true);
      const userHasL1 = user && (user.role==='admin' || user.role==='marketing' || user.canAccessL1===true);
      const blocked = user && ((PAGE_VIEW === 'dashboard' && !userHasDashboard) || (PAGE_VIEW === 'l1' && !userHasL1));
      if(user && !blocked){
        SESSION = {id:user.id, name:user.name, role:user.role, locationId:user.locationId||'', canAccessDashboard:user.canAccessDashboard===true, canAccessL1:user.canAccessL1===true};
        ROUTE = pageAllowedRoutes()[0];
      } else {
        sessionStorage.removeItem('prf_session_userid');
      }
    }
  }catch(e){}
  BOOTED = true;
  setupInactivityWatch();
  if(SESSION) resetInactivityTimer();
  render();
}
boot();