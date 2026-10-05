// Runs inside GitHub Actions (Node 20, built-in fetch) — fetches every table this app
// depends on directly via Supabase's REST API, bundles it into one JSON file, and
// writes it into backups/. No browser involved, so this runs reliably on schedule
// regardless of whether anyone has the app open.

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables.');
  process.exit(1);
}

// Supabase caps a single request at 1000 rows by default — pages through with the
// Range header (same approach the app itself uses) so every row is actually fetched,
// no matter how large a table has grown.
async function fetchAllRows(table, orderCol = 'id') {
  const pageSize = 1000;
  let allRows = [];
  let from = 0;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=${orderCol}.asc`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Range: `${from}-${from + pageSize - 1}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch ${table} (status ${res.status}): ${text}`);
    }
    const rows = await res.json();
    allRows = allRows.concat(rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return allRows;
}

async function main() {
  console.log('Starting backup...');
  const backup = {
    exportedAt: new Date().toISOString(),
    exportedBy: 'GitHub Actions (automated)',
    kvStore: {},
    entries: [],
    htentries: [],
    cncentries: [],
    auditLog: [],
  };

  console.log('Fetching kv_store (Machines/Items/Shifts/Users/etc.)...');
  const kvRows = await fetchAllRows('kv_store', 'key');
  kvRows.forEach((row) => {
    backup.kvStore[row.key] = row.value;
  });

  console.log('Fetching Forging entries...');
  backup.entries = await fetchAllRows('prf_entries_v2');

  console.log('Fetching HT entries...');
  backup.htentries = await fetchAllRows('prf_ht_entries');

  console.log('Fetching CNC entries...');
  backup.cncentries = await fetchAllRows('prf_cnc_entries');

  console.log('Fetching Audit Log...');
  try {
    backup.auditLog = await fetchAllRows('prf_audit_log');
  } catch (e) {
    console.warn('Audit Log fetch failed (non-fatal, continuing without it):', e.message);
  }

  const dir = path.join(__dirname, 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = path.join(dir, `prf-backup-${timestamp}.json`);
  fs.writeFileSync(filename, JSON.stringify(backup, null, 2));

  const totalRecords =
    Object.values(backup.kvStore).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0) +
    backup.entries.length + backup.htentries.length + backup.cncentries.length + backup.auditLog.length;

  console.log(`Backup written to ${filename}`);
  console.log(`Total records backed up: ${totalRecords}`);
}

main().catch((err) => {
  console.error('Backup failed:', err);
  process.exit(1);
});
