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

  ⛔ WHO CAN SIGN IN IS NEVER PART OF A RESTORE BY DEFAULT (security fix 6).
     config/users, authMap and loginAlias — the only things deactivating someone
     or resetting their password actually changes — are put back to what they
     were a moment before the restore, not to what the backup file says. A
     restore can only turn back farmer/operational data, never bring back
     someone's access. To restore those three paths from the file too (rare —
     only for recovering from the accounts themselves being lost), add:
         --restore-accounts-too
     and read the warning it prints before using it.
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
// security fix 6 (NV-27): who can sign in, and as what, must never move backwards. The app only
// ever marks someone deactivated or resets their password by changing config/users, authMap (and
// loginAlias) in the database — it has no way to disable the old Firebase Auth account. A restore
// used to write the backup file's old copy of those three paths straight over the target, which
// silently undid every deactivation and password reset made since the backup was taken. By
// default this script now puts those three paths back to what they were A MOMENT AGO (read in
// step 2, before anything is overwritten) right after the restore, so a restore can only change
// farmer/operational data, never who has access. --restore-accounts-too turns this off.
const RESTORE_ACCOUNTS_TOO = argv.includes('--restore-accounts-too');
const IDENTITY_PATHS = ['config/users', 'authMap', 'loginAlias'];

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

// security fix 6 (NV-27): the target's identity state A MOMENT AGO — read here, before anything
// is overwritten, so step 3 can put it straight back after the restore.
let beforeState = null;
if (!wasEmpty) {
  try { beforeState = JSON.parse(safetyRaw.toString('utf8')); }
  catch (e) { die('REFUSED — the safety backup just taken is not valid JSON, so who-can-sign-in\nstate could not be read. Nothing has been changed.'); }
}
const getPath = (o, p) => p.split('/').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);
const identityBefore = {};
IDENTITY_PATHS.forEach(p => { identityBefore[p] = getPath(beforeState, p); if (identityBefore[p] === undefined) identityBefore[p] = null; });

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

// security fix 6 (NV-27): put who-can-sign-in back to what it was a moment ago, unless the
// operator explicitly asked for the backup file's copy of it too.
if (RESTORE_ACCOUNTS_TOO) {
  console.log('\n   ⚠  --restore-accounts-too was set: config/users, authMap and loginAlias were');
  console.log('      left as the backup file wrote them. If anyone was deactivated, or had their');
  console.log('      password reset, AFTER this backup was taken, that is now UNDONE — they have');
  console.log('      their old access back. Re-apply those revocations by hand if that is not');
  console.log('      what you wanted; the pre-restore copy is in: ' + path.basename(safety));
} else {
  const idUpd = path.join(OUT_DIR, '_restore_identity_' + stamp + '.json');
  fs.writeFileSync(idUpd, JSON.stringify(identityBefore));
  try {
    fb('database:update "' + dbPath + '" "' + idUpd + '" --force');
  } catch (e) {
    console.error(String((e.stderr || '')).split('\n').slice(0, 6).join('\n'));
    die('FAILED — the restore wrote the file, but putting who-can-sign-in back to what it was\n' +
        'just before could not be confirmed. Check config/users, authMap and loginAlias by hand\n' +
        'before trusting this namespace, or restore the safety backup:\n' +
        '  node restore.js "' + safety + '" --to ' + target +
        (target === LIVE_NS ? ' --i-am-overwriting-live' : ''));
  }
  fs.unlinkSync(idUpd);
  console.log('   config/users, authMap, loginAlias put back to what they were a moment ago');
  console.log('   (not what the backup file says — see the note at the top of this file).');
}

// --------------------------------------------- 4. prove it actually took ---
console.log('\n4. Reading it back to prove it matches');
const check = path.join(OUT_DIR, '_verify_' + stamp + '.json');
fb('database:get "' + dbPath + '" -o "' + check + '"');
const backTxt = fs.readFileSync(check, 'utf8');
let back;
try { back = JSON.parse(backTxt); }
catch (e) { die('FAILED — what came back is not valid JSON.'); }

// security fix 6 (NV-27): "matches the backup file" must mean "matches what this restore was
// actually SUPPOSED to produce" — the file's data, but with identity put back to its pre-restore
// state (unless --restore-accounts-too). Built once here so every check below compares against
// the right thing instead of flagging the deliberate identity substitution as a failure.
const expected = JSON.parse(JSON.stringify(data));
if (!RESTORE_ACCOUNTS_TOO) {
  // Firebase prunes a parent that is left with no children (it never stores an empty node), so
  // the comparison below must match that: a delete that empties config/* must remove config too.
  const setPath = (o, p, v) => {
    const ks = p.split('/'); const chain = [o];
    for (let i = 0; i < ks.length - 1; i++) {
      const n = chain[chain.length - 1];
      if (n[ks[i]] == null || typeof n[ks[i]] !== 'object') n[ks[i]] = {};
      chain.push(n[ks[i]]);
    }
    const leaf = chain[chain.length - 1];
    if (v === null) {
      delete leaf[ks[ks.length - 1]];
      for (let i = chain.length - 2; i >= 0; i--) if (Object.keys(chain[i + 1]).length === 0) delete chain[i][ks[i]]; else break;
    } else leaf[ks[ks.length - 1]] = v;
  };
  IDENTITY_PATHS.forEach(p => setPath(expected, p, identityBefore[p]));
}
const expectedNodes = Object.keys(expected);
const expectedGujarati = (JSON.stringify(expected).match(/[઀-૿]/g) || []).length;

// Canonical form: key order does not survive a round trip, values must.
const canon = o => JSON.stringify(o, Object.keys(flatten(o)).sort());
function flatten(o, out, pre) {
  out = out || {}; pre = pre || '';
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const k of Object.keys(o)) { out[k] = 1; flatten(o[k], out, pre + '/' + k); }
  } else if (Array.isArray(o)) { o.forEach(v => flatten(v, out, pre)); }
  return out;
}
const same = canon(expected) === canon(back);
const gujBack = (backTxt.match(/[઀-૿]/g) || []).length;

let counts = [];
for (const k of expectedNodes) {
  const a = expected[k] && typeof expected[k] === 'object' ? Object.keys(expected[k]).length : 1;
  const b = back && back[k] && typeof back[k] === 'object' ? Object.keys(back[k]).length : (back && k in back ? 1 : 0);
  counts.push({ k, a, b, ok: a === b });
}
const missing = counts.filter(c => !c.ok);

console.log('   nodes restored  : ' + counts.filter(c => c.ok).length + ' of ' + counts.length);
console.log('   Gujarati chars  : ' + gujBack.toLocaleString() + (gujBack === expectedGujarati ? '  (all of them)' : '  ** ' + (expectedGujarati - gujBack) + ' MISSING **'));
console.log('   values identical: ' + (same ? 'yes' : 'NO'));
for (const c of missing) console.log('   ** ' + c.k + ': ' + c.a + ' expected, ' + c.b + ' in the database');

fs.unlinkSync(check);

if (missing.length || gujBack !== expectedGujarati || !same) {
  die('FAILED — the database does not match what this restore was supposed to produce.\n' +
      'Your undo is: ' + safety);
}

console.log('\nOK — ' + dbPath + ' now matches the backup file' +
            (RESTORE_ACCOUNTS_TOO ? ' exactly.' : ', apart from config/users, authMap and\nloginAlias, which were kept as they were a moment ago (see step 3).'));
console.log('Undo, if this was the wrong file:');
console.log('  node restore.js "' + safety + '" --to ' + target +
            (target === LIVE_NS ? ' --i-am-overwriting-live' : ''));
