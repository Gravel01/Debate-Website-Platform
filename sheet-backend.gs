/**
 * Drill Room — backend for drills, events, credits, and the coach dashboard.
 * Setup instructions are in README.md.
 *
 * The security model in one paragraph: the browser never asserts who it is.
 * Every call carries a Google ID token; this script hands that token to
 * Google, gets a verified email back, and answers only for that email. A
 * student sees their own drills and their own balance, and nothing else
 * exists as far as they are concerned. An account that is not on the roster
 * gets nothing at all — there is no self-serve sign-up, so the only way onto
 * the roster is the coach adding the address. Admin actions additionally
 * require that verified email to be in ADMIN_EMAILS.
 */

var SHEET_ID = '';   // '' when the script lives inside the Sheet

// OAuth client ID from Cloud Console > Credentials > OAuth client > Web
// application. Must be byte-identical to the one in index.html and
// admin.html, or every token is rejected as minted for a different site.
var GOOGLE_CLIENT_ID = '604736692184-9e0dv1jekuaqvkqgsuuatjgjlrg9bklu.apps.googleusercontent.com';

// Exact addresses allowed to open the coach dashboard. Deliberately a list
// of addresses and not a domain test: domain matching only works if the
// domain is a Google Workspace domain, and fails silently if it is just
// email forwarding, which is the kind of failure you find out about late.
var ADMIN_EMAILS = [
  'nate.watkins@utexas.edu',
  'watkinsnate25@gmail.com'
];

// Cap on anything a student can type, so nobody can grow the Sheet without
// bound. Requests over this are truncated, not rejected.
var MAX_FIELD = 4000;


/* ================= routing ================= */

// The public GET says only whether the service is alive. Drills, events and
// balances all moved to authenticated POSTs when drills became per-student —
// a public GET cannot tell who is asking, so it cannot answer safely.
function doGet(e) {
  var p = (e && e.parameter) || {};

  if (p.view === 'admin') {
    return HtmlService.createHtmlOutput(
      '<div style="font:15px/1.6 system-ui;padding:48px;max-width:34em;margin:auto">' +
      '<h2>The dashboard moved</h2>' +
      '<p>It is now a page on the site, so it can use the same verified ' +
      'Google sign-in as everything else:</p>' +
      '<p><a href="https://drills.nwatkins.org/admin.html">drills.nwatkins.org/admin.html</a></p>' +
      '</div>'
    ).setTitle('Drill Room — dashboard moved');
  }

  return json({
    ok: true,
    service: 'drillroom',
    configured: !!GOOGLE_CLIENT_ID
  });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json({ ok: false, error: 'bad request' }); }

  var action = String(body.action || '');

  // One verification, up front, for every action. Below this line `email` is
  // a fact checked by Google; nothing else from the browser is trusted.
  var email = verifyIdToken(body.idToken);
  if (!email) return json({ ok: false, error: 'signed out' });

  if (action.indexOf('admin') === 0) {
    if (!isAdmin(email)) return json({ ok: false, error: 'not authorised' });
    if (action === 'adminData')    return json(adminData(email));
    if (action === 'adminStatus')  return json(adminSetStatus(body.row, body.status));
    if (action === 'adminGrant')   return json(adminGrant(body.row, body.granted));
    if (action === 'adminEnroll')  return json(adminEnroll(body));
    if (action === 'adminRemove')  return json(adminRemove(body.row));
    return json({ ok: false, error: 'unknown action' });
  }

  // Roster gate. An address the coach has not added is a stranger, and a
  // stranger is told only that they are not on the roster.
  var s = studentRow(email);
  if (!s) return json({ ok: true, enrolled: false, email: email });

  if (action === 'me')      return json(meResponse(s));
  if (action === 'content') return json(contentFor(s));
  if (action === 'spend')   return json(spendFor(s));
  if (action === 'request') return json(saveRequest(s, body.fields));

  return json({ ok: false, error: 'unknown action' });
}


/* ================= identity ================= */

// Verify a Google ID token with Google, not with ourselves. Returns the
// verified lowercase email, or '' for anything we could not vouch for.
//
// The token is signed by Google and expires in about an hour, so a stolen
// one is short-lived. Everything this script answers hangs off the return
// value of this function.
function verifyIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) return '';
  if (typeof idToken !== 'string') return '';
  if (idToken.length < 20 || idToken.length > 8192) return '';

  // tokeninfo is a network round trip; cache the verdict briefly so a page
  // load doing three calls does not pay for three of them. Keyed by a digest
  // of the token, so the cache cannot be probed with a guessed key.
  var cache = CacheService.getScriptCache();
  var key = 'idt_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  var hit = cache.get(key);
  if (hit) return hit;

  var res;
  try {
    res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true });
  } catch (err) {
    return '';
  }
  if (res.getResponseCode() !== 200) return '';

  var p;
  try { p = JSON.parse(res.getContentText()); } catch (err) { return ''; }

  // A token minted for some other site is not a login here. This is the
  // check that stops someone pasting a token from an unrelated app.
  if (p.aud !== GOOGLE_CLIENT_ID) return '';

  // Google is the only issuer we accept.
  if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') return '';

  // An unverified address can be one the holder does not actually control.
  if (String(p.email_verified) !== 'true') return '';
  if (!p.email) return '';

  var expSec = Number(p.exp) || 0;
  var nowSec = Math.floor(Date.now() / 1000);
  if (expSec <= nowSec) return '';

  var email = String(p.email).toLowerCase();
  var ttl = Math.min(300, expSec - nowSec);
  if (ttl > 0) cache.put(key, email, ttl);
  return email;
}

function isAdmin(email) {
  var want = String(email || '').trim().toLowerCase();
  if (!want) return false;
  for (var i = 0; i < ADMIN_EMAILS.length; i++) {
    if (String(ADMIN_EMAILS[i]).trim().toLowerCase() === want) return true;
  }
  return false;
}

// A soft guard against one account hammering the Sheet. Not a security
// boundary — the roster already is — just a cap on accidental damage.
function withinRate(email, bucket, max, windowSec) {
  var cache = CacheService.getScriptCache();
  var key = 'rl_' + bucket + '_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email));
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), windowSec);
  return n <= max;
}


/* ================= roster ================= */

// The Credits tab is the roster. A row whose email column is filled in is an
// enrolled student; every other Google account in the world is not.
// Column F (email) is what links an account to a row — the code in column A
// is a label for the coach, never a credential.
function studentRow(email) {
  var rows = sheet('Credits').getDataRange().getValues();
  var want = String(email || '').trim().toLowerCase();
  if (!want) return null;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][5] || '').trim().toLowerCase() !== want) continue;
    return {
      row: i + 1,
      code: str(rows[i][0]),
      granted: Number(rows[i][1]) || 0,
      used: Number(rows[i][2]) || 0,
      student: str(rows[i][3]),
      email: want
    };
  }
  return null;
}

// What a signed-in student is allowed to know: their own row, nothing else.
function meResponse(s) {
  return {
    ok: true, enrolled: true, email: s.email, student: s.student,
    code: s.code, granted: s.granted, used: s.used
  };
}


/* ================= per-student content ================= */

// Blank "assigned to" means everyone; otherwise the student's address has to
// appear in the list. Accepts commas, semicolons or spaces between addresses.
function assignedTo(cell, email) {
  var raw = str(cell).toLowerCase();
  if (!raw) return true;
  var list = raw.split(/[,;\s]+/);
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i] === email) return true;
  }
  return false;
}

function readDrills(email) {
  var out = [];
  rowsOf('Drills').forEach(function (r) {
    var id = str(r[0]), title = str(r[1]);
    if (!id || !title) return;
    if (!assignedTo(r[4], email)) return;
    out.push({ id: id, title: title, desc: str(r[2]), time: str(r[3]) });
  });
  return out;
}

function readEvents(email) {
  var out = [];
  rowsOf('Events').forEach(function (r) {
    var date = asDate(r[0]), title = str(r[2]);
    if (!date || !title) return;
    if (!assignedTo(r[5], email)) return;
    out.push({
      date: date, time: str(r[1]), title: title,
      type: (str(r[3]) || 'session').toLowerCase(), note: str(r[4])
    });
  });
  return out;
}

function readSetting(key) {
  var rows = rowsOf('Settings');
  for (var i = 0; i < rows.length; i++) {
    if (str(rows[i][0]) === key) return str(rows[i][1]);
  }
  return '';
}

function contentFor(s) {
  return {
    ok: true,
    enrolled: true,
    weekLabel: readSetting('weekLabel'),
    drills: readDrills(s.email),
    events: readEvents(s.email)
  };
}


/* ================= student writes ================= */

function spendFor(s) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (err) { return { ok: false, error: 'busy, try again' }; }

  try {
    // Re-read inside the lock. The copy passed in was read before we held
    // it, so it may already be stale by a concurrent spend.
    var fresh = studentRow(s.email);
    if (!fresh) return { ok: false, error: 'signed out' };
    if (fresh.granted - fresh.used <= 0) return { ok: false, error: 'empty' };

    var sh = sheet('Credits');
    var used = fresh.used + 1;
    sh.getRange(fresh.row, 3).setValue(used);        // C = used
    sh.getRange(fresh.row, 5).setValue(new Date());  // E = last used
    return { ok: true, used: used, granted: fresh.granted };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

function saveRequest(s, fields) {
  if (!withinRate(s.email, 'req', 30, 3600)) {
    return { ok: false, error: 'too many requests, try again later' };
  }
  var f = fields || {};
  try {
    // Identity columns come from the verified row, never from the payload.
    sheet('Requests').appendRow([
      new Date(),
      cap(f.form),
      s.student,
      s.email,
      s.code,
      cap(f.topic || f.event),
      cap(f.request_type || f.skill_area),
      cap(f.details || f.notes),
      cap(f.needed_by),
      'open'
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


/* ================= coach dashboard ================= */

function adminData(who) {
  var credits  = sheet('Credits').getDataRange().getValues();
  var requests = sheet('Requests').getDataRange().getValues();
  var tz = book().getSpreadsheetTimeZone();
  var fmt = function (v) {
    return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : str(v);
  };

  // Drill banks, emptiest first — those are the ones about to need a refill.
  var students = [];
  for (var i = 1; i < credits.length; i++) {
    var r = credits[i];
    if (!str(r[0]) && !str(r[5])) continue;
    var granted = Number(r[1]) || 0, used = Number(r[2]) || 0;
    students.push({
      row: i + 1, code: str(r[0]), student: str(r[3]), email: str(r[5]),
      granted: granted, used: used, left: granted - used, last: fmt(r[4])
    });
  }
  students.sort(function (a, b) { return a.left - b.left; });

  // Open work first, then by deadline.
  var work = [];
  for (var j = 1; j < requests.length; j++) {
    var q = requests[j];
    if (!str(q[3]) && !str(q[7])) continue;
    work.push({
      row: j + 1, received: fmt(q[0]), student: str(q[2]), email: str(q[3]),
      topic: str(q[5]), category: str(q[6]), details: str(q[7]),
      due: fmt(q[8]), status: str(q[9]) || 'open'
    });
  }
  work.sort(function (a, b) {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    return String(a.due || '9999').localeCompare(String(b.due || '9999'));
  });

  return { ok: true, admin: who, students: students, requests: work };
}

function adminSetStatus(rowNumber, status) {
  var sh = sheet('Requests');
  var row = Number(rowNumber);
  if (!(row >= 2 && row <= sh.getLastRow())) return { ok: false, error: 'no such row' };
  sh.getRange(row, 10).setValue(status === 'done' ? 'done' : 'open');
  return { ok: true };
}

function adminGrant(rowNumber, granted) {
  var sh = sheet('Credits');
  var row = Number(rowNumber);
  var n = Number(granted);
  if (!(row >= 2 && row <= sh.getLastRow())) return { ok: false, error: 'no such row' };
  if (!(n >= 0 && n <= 100000)) return { ok: false, error: 'bad amount' };
  // Raise granted; never touch used, or the history is lost.
  sh.getRange(row, 2).setValue(Math.floor(n));
  return { ok: true };
}

// The only way onto the roster. There is no student-facing equivalent.
function adminEnroll(body) {
  var email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'bad email' };
  if (studentRow(email)) return { ok: false, error: 'that address is already on the roster' };

  var granted = Number(body.granted);
  if (!(granted >= 0 && granted <= 100000)) granted = 0;

  sheet('Credits').appendRow([
    cap(body.code), Math.floor(granted), 0, cap(body.student), '', email
  ]);
  return { ok: true };
}

function adminRemove(rowNumber) {
  var sh = sheet('Credits');
  var row = Number(rowNumber);
  if (!(row >= 2 && row <= sh.getLastRow())) return { ok: false, error: 'no such row' };
  // Clearing the email revokes access but keeps the credit history intact.
  sh.getRange(row, 6).setValue('');
  return { ok: true };
}


/* ================= helpers ================= */

function book() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}
function sheet(name) {
  var sh = book().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet tab: ' + name + ' — run setupSheet() once.');
  return sh;
}
// Data rows only (header dropped).
function rowsOf(name) {
  return sheet(name).getDataRange().getValues().slice(1);
}
function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}
function cap(v) {
  return str(v).slice(0, MAX_FIELD);
}
// Accepts a real date cell or a plain "YYYY-MM-DD" string.
function asDate(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, book().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  var s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// Run once from the editor. Safe to re-run; existing tabs are left alone.
function setupSheet() {
  var ss = book();
  var specs = [
    ['Drills',   ['id', 'title', 'desc', 'time', 'assigned to (email, blank = everyone)'],
                 ['w1-rebuttal-redo', '2NR redo x 3',
                  'Re-give your last practice-round 2NR three times. Third rep must finish 30 seconds under time.',
                  '45 min', '']],
    ['Events',   ['date (YYYY-MM-DD)', 'time', 'title', 'type (session/tournament/deadline)',
                  'note', 'assigned to (email, blank = everyone)'],
                 ['2026-10-02', '6:00 PM', 'Practice round - LD', 'session', 'Bring your flows.', '']],
    ['Credits',  ['code', 'granted', 'used', 'student', 'last used', 'email (this is the roster)'],
                 ['FALCON-07', 20, 0, 'Sebastian Alvarez', '',
                  'sebastian@example.com']],
    ['Settings', ['key', 'value'],
                 ['weekLabel', 'Week of September 28']],
    ['Requests', ['received', 'form', 'student', 'email', 'code',
                  'topic', 'category', 'details', 'needed by', 'status'],
                 [new Date(), 'file_request', 'Sebastian Alvarez',
                  'sebastian@example.com', 'FALCON-07', 'Neg - Kant NC',
                  'Review my case / blocks', 'Blocks feel thin vs util.',
                  '2026-10-05', 'open']]
  ];

  specs.forEach(function (spec) {
    var name = spec[0], header = spec[1], sample = spec[2];
    if (ss.getSheetByName(name)) return;
    var sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.getRange(2, 1, 1, sample.length).setValues([sample]);
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, header.length);
  });

  var first = ss.getSheets()[0];
  if (first.getName() === 'Sheet1' && first.getLastRow() === 0) ss.deleteSheet(first);
}

// Upgrades a Sheet created by the previous version, which had no "assigned
// to" columns. Safe to re-run.
function upgradeSheet() {
  var d = sheet('Drills');
  if (str(d.getRange(1, 5).getValue()) === '') {
    d.getRange(1, 5).setValue('assigned to (email, blank = everyone)').setFontWeight('bold');
  }
  var e = sheet('Events');
  if (str(e.getRange(1, 6).getValue()) === '') {
    e.getRange(1, 6).setValue('assigned to (email, blank = everyone)').setFontWeight('bold');
  }
  var c = sheet('Credits');
  if (str(c.getRange(1, 6).getValue()) === '') {
    c.getRange(1, 6).setValue('email (this is the roster)').setFontWeight('bold');
  }
}
