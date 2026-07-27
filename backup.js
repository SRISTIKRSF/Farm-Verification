#!/usr/bin/env node
/*
  Sristi Farm Verification — safe database backup.

  WHY THIS EXISTS
  ---------------
  The earlier backups were taken with a shell redirect:

      firebase database:get /prakrutik_kheti > backup.json

  On Windows that is NOT byte-faithful. The shell decodes the CLI's UTF-8
  output using the console code page and re-encodes it, so every non-ASCII
  character is silently mangled:

      "FC verification — 28/33"   became   "FC verification ΓÇö 28/33"
      Gujarati names and villages became   mojibake

  The files still parse as JSON, so the damage is invisible until you restore
  from one — at which point you write the corruption into the live database.
  A backup you cannot safely restore from is not a backup.

  This script never lets the shell touch the bytes: `firebase database:get -o`
  writes the file itself. It then RE-READS the file and proves the round trip
  survived before declaring success.

  USAGE
      node backup.js                 # full database
      node backup.js config/users    # just one path

  Output: _backups/<namespace>_<UTC timestamp>[_<path>].json
*/

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const PROJECT   = 'prakrutik-kheti-e9194';
const NAMESPACE = 'prakrutik_kheti';
const OUT_DIR   = path.join(__dirname, '_backups');

const subPath = (process.argv[2] || '').replace(/^\/+|\/+$/g, '');
const dbPath  = '/' + NAMESPACE + (subPath ? '/' + subPath : '');

// Timestamp is UTC and filename-safe: 2026-07-27T09-42-11Z
const stampUtc = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
const label    = subPath ? '_' + subPath.replace(/[\/]/g, '-') : '';
const outFile  = path.join(OUT_DIR, `${NAMESPACE}_${stampUtc}${label}.json`);

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('Backing up ' + dbPath);
console.log('        -> ' + outFile);

try {
  // -o makes the Firebase CLI write the file directly. No shell redirect, so
  // no console-code-page round trip, so no mojibake.
  // MSYS_NO_PATHCONV=1 stops Git Bash rewriting the leading-slash database
  // path ("/prakrutik_kheti") into a Windows path — without it the CLI is
  // handed "D:/Git/prakrutik_kheti" and fails.
  // Args are quoted by hand: this project's own folder contains spaces
  // ("Claude Apps"), and a shell invocation would otherwise split the output
  // path into several arguments and fail with an empty error.
  const cmd = `firebase database:get "${dbPath}" -o "${outFile}" --project ${PROJECT}`;
  execSync(cmd, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }),
  });
} catch (e) {
  console.error('\nFAILED: the firebase CLI errored. Nothing was written.');
  const err = e && e.stderr ? e.stderr.toString().trim() : '';
  if (err) console.error(err.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

// ---- verify the file we just wrote is actually usable ----
if (!fs.existsSync(outFile)) { console.error('FAILED: no file was produced.'); process.exit(1); }

const buf = fs.readFileSync(outFile);
const txt = buf.toString('utf8');

let data;
try { data = JSON.parse(txt); }
catch (e) { console.error('FAILED: the file is not valid JSON — ' + e.message); process.exit(1); }
if (data === null) { console.error('FAILED: that path is empty in the database.'); process.exit(1); }

// Re-encoding must be byte-identical, i.e. the file really is UTF-8.
const utf8Clean = Buffer.compare(Buffer.from(txt, 'utf8'), buf) === 0;

// Mojibake fingerprints: UTF-8 bytes that were decoded as CP850/CP1252.
// "ΓÇö" is an em dash that has been through exactly that.
const MOJIBAKE = /[ΓÃâ][ÇÂ][öÖ¬]|à¤|Ã‚|â€”/;
const mojibake = MOJIBAKE.test(txt);

// Gujarati must survive as Gujarati (U+0A80–U+0AFF).
const gujaratiChars = (txt.match(/[઀-૿]/g) || []).length;

const sizeMb = (buf.length / 1048576).toFixed(2);
const topKeys = Object.keys(data);

console.log('\nVerification');
console.log('  size              : ' + sizeMb + ' MB');
console.log('  valid JSON        : yes');
console.log('  top-level keys    : ' + (topKeys.length > 12 ? topKeys.length + ' keys' : topKeys.join(', ')));
console.log('  clean UTF-8       : ' + (utf8Clean ? 'yes' : 'NO'));
console.log('  Gujarati chars    : ' + gujaratiChars);
console.log('  mojibake detected : ' + (mojibake ? 'YES' : 'no'));

if (!utf8Clean || mojibake) {
  console.error('\nREJECTED — this backup is corrupted and must NOT be restored from.');
  fs.renameSync(outFile, outFile + '.CORRUPT');
  console.error('Renamed to ' + path.basename(outFile) + '.CORRUPT so it cannot be used by mistake.');
  process.exit(1);
}

// A full-database backup with no Gujarati at all means something stripped it.
if (!subPath && gujaratiChars === 0) {
  console.error('\nREJECTED — a full backup with zero Gujarati characters is not credible.');
  fs.renameSync(outFile, outFile + '.SUSPECT');
  process.exit(1);
}

console.log('\nOK — backup verified and safe to restore from.');
