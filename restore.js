#!/usr/bin/env node
/*
  Sristi Farm Verification — restore the database from a backup file.

  WHY THIS EXISTS
  ---------------
  `backup.js` has always written backups and proved the FILE is readable.
  Nothing had ever proved a file could be put BACK, and there was no tool to do
  it — the only route was a hand-typed `firebase database:set`, one character
  away from writing a backup over the wrong namespace.

  Tested end to end on 1 September 2026:
    • staging destroyed four ways (a whole node deleted, records deleted, a
      record overwritten with junk, a farmer's visits emptied) and restored —
      identical at every depth, 88 verification answers intact
    • the real 20.2 MB weekly backup of live written to a throwaway namespace
      and read back — all 21 nodes, all 513 farmers, all 560 forms and all
      2,132,218 Gujarati characters identical

  WHAT IT DOES, IN ORDER
    1. reads the backup file and REFUSES it if it is corrupt (bad JSON, not
       UTF-8, mojibake fingerprints, or a full backup with no Gujarati)
    2. takes a SAFETY BACKUP of whatever it is about to overwrite, so the
       restore itself can be undone
    3. writes the file to the target namespace
    4. reads it back and proves the result matches the file

  USAGE
      node restore.js <backup-file> --to <namespace>

      node restore.js _backups/prakrutik_kheti_2026-08-31T04-30-01Z.json \
           --to prakrutik_kheti_staging

  ⛔ Restoring over LIVE additionally requires --i-am-overwriting-live.
     There is no prompt to click through by accident: the flag has to be typed.

  ⛔ A restore REPLACES the whole namespace. Anything added since the backup
     was taken is gone. That is why step 2 exists — read the safety backup path
     it prints before you do anything else.
*/

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const PROJECT   = 'prakrutik-kheti-e9194';
const LIVE_NS   = 'prakrutik_kheti';
const OUT_DIR   = path.join(__dirname, '_backups');

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
const toIx = argv.indexOf('--to');
const target = toIx >= 0 ? argv[toIx + 1] : null;
const liveOk = argv.includes('--i-am-overwriting-live');

function die(msg) { console.error('\n' + msg + '\n'); process.exit(1); }

if (!file || !target) {
  die('Usage:  node restore.js <backup-file> --to <namespace>\n' +
      '        node restore.js --help  for the full notes at the top of this file');
}
if (!fs.existsSync(file)) die('No such file: ' + file);
if (!/^[a-z0-9_]+$/.test(target)) die('That does not look like a namespace: ' + target);
if (target === LIVE_NS && !liveOk) {
  die('REFUSED — that is the LIVE namespace.\n' +
      'A restore REPLACES everything in it, including anything the field team has\n' +
      'added since this backup was taken.\n\n' +
      'If that is genuinely what you want, add:  --i-am-overwriting-live');
}

const dbPath = '/' + target;
const runEnv = Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' });

function fb(args) {
  return execSync('firebase ' + args + ' --project ' + PROJECT,
                  { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
}

// ------------------------------------------------- 1. vet the source file --
console.log('Restore\n  from : ' + file + '\n  into : ' + dbPath + '\n');
console.log('1. Checking the backup file');

const buf = fs.readFileSync(file);
const txt = buf.toString('utf8');

let data;
try { data = JSON.parse(txt); }
catch (e) { die('REFUSED — the file is not valid JSON: ' + e.message); }
if (data === null || typeof data !== 'object') die('REFUSED — the file has no data in it.');

// Byte-identical re-encoding, i.e. it really is UTF-8 and not a mangled dump.
const utf8Clean = Buffer.compare(Buffer.from(txt, 'utf8'), buf) === 0;
// UTF-8 bytes that were decoded through a Windows console code page.
const MOJIBAKE  = /[ΓÃâ][ÇÂ][öÖ¬]|à¤|Ã‚|â€”/;
const mojibake  = MOJIBAKE.test(txt);
const gujarati  = (txt.match(/[઀-૿]/g) || []).length;
const nodes     = Object.keys(data);
const looksFull = nodes.length > 5;

console.log('   size            : ' + (buf.length / 1048576).toFixed(2) + ' MB');
console.log('   top-level nodes : ' + nodes.length + (looksFull ? '' : '  (' + nodes.join(', ') + ')'));
console.log('   clean UTF-8     : ' + (utf8Clean ? 'yes' : 'NO'));
console.log('   Gujarati chars  : ' + gujarati.toLocaleString());
console.log('   mojibake        : ' + (mojibake ? 'YES' : 'no'));

if (!utf8Clean || mojibake) {
  die('REFUSED — this backup is corrupted. Restoring it would write the corruption\n' +
      'into the database. See the note at the top of backup.js.');
}
if (looksFull && gujarati === 0) {
  die('REFUSED — a full backup with zero Gujarati characters is not credible.');
}

// --------------------------------------- 2. safety backup of the target ----
console.log('\n2. Backing up what is about to be replaced');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp    = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
const safety   = path.join(OUT_DIR, target + '_' + stamp + '_BEFORE-RESTORE.json');

try {
  fb('database:get "' + dbPath + '" -o "' + safety + '"');
} catch (e) {
  die('REFUSED — could not read the current contents of ' + dbPath + ', so the\n' +
      'restore could not be made undoable. Nothing has been changed.\n' +
      String((e.stderr || '')).split('\n').slice(0, 4).join('\n'));
}
const safetyRaw = fs.existsSync(safety) ? fs.readFileSync(safety) : Buffer.alloc(0);
const wasEmpty  = safetyRaw.toString('utf8').trim() === 'null';
console.log('   saved to : ' + path.basename(safety));
console.log('   ' + (wasEmpty ? 'that namespace was empty' :
             'size ' + (safetyRaw.length / 1048576).toFixed(2) + ' MB — this is your undo'));

// ------------------------------------------------------- 3. the restore ----
console.log('\n3. Writing');
const t0 = Date.now();
try {
  fb('database:set "' + dbPath + '" "' + file + '" --force');
} catch (e) {
  console.error(String((e.stderr || '')).split('\n').slice(0, 6).join('\n'));
  die('FAILED — the write did not complete. The namespace may be half-written.\n' +
      'Restore the safety backup above before anything else uses it:\n' +
      '  node restore.js "' + safety + '" --to ' + target +
      (target === LIVE_NS ? ' --i-am-overwriting-live' : ''));
}
console.log('   accepted in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

// --------------------------------------------- 4. prove it actually took ---
console.log('\n4. Reading it back to prove it matches');
const check = path.join(OUT_DIR, '_verify_' + stamp + '.json');
fb('database:get "' + dbPath + '" -o "' + check + '"');
const backTxt = fs.readFileSync(check, 'utf8');
let back;
try { back = JSON.parse(backTxt); }
catch (e) { die('FAILED — what came back is not valid JSON.'); }

// Canonical form: key order does not survive a round trip, values must.
const canon = o => JSON.stringify(o, Object.keys(flatten(o)).sort());
function flatten(o, out, pre) {
  out = out || {}; pre = pre || '';
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const k of Object.keys(o)) { out[k] = 1; flatten(o[k], out, pre + '/' + k); }
  } else if (Array.isArray(o)) { o.forEach(v => flatten(v, out, pre)); }
  return out;
}
const same = canon(data) === canon(back);
const gujBack = (backTxt.match(/[઀-૿]/g) || []).length;

let counts = [];
for (const k of nodes) {
  const a = data[k] && typeof data[k] === 'object' ? Object.keys(data[k]).length : 1;
  const b = back && back[k] && typeof back[k] === 'object' ? Object.keys(back[k]).length : (back && k in back ? 1 : 0);
  counts.push({ k, a, b, ok: a === b });
}
const missing = counts.filter(c => !c.ok);

console.log('   nodes restored  : ' + counts.filter(c => c.ok).length + ' of ' + counts.length);
console.log('   Gujarati chars  : ' + gujBack.toLocaleString() + (gujBack === gujarati ? '  (all of them)' : '  ** ' + (gujarati - gujBack) + ' MISSING **'));
console.log('   values identical: ' + (same ? 'yes' : 'NO'));
for (const c of missing) console.log('   ** ' + c.k + ': ' + c.a + ' in the file, ' + c.b + ' in the database');

fs.unlinkSync(check);

if (missing.length || gujBack !== gujarati || !same) {
  die('FAILED — the database does not match the backup file.\n' +
      'Your undo is: ' + safety);
}

console.log('\nOK — ' + dbPath + ' now matches the backup file exactly.');
console.log('Undo, if this was the wrong file:');
console.log('  node restore.js "' + safety + '" --to ' + target +
            (target === LIVE_NS ? ' --i-am-overwriting-live' : ''));
