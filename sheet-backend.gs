/**
 * Drill Room — backend for drills, events, credits, and the coach dashboard.
 * Setup instructions are in README.md.
 *
 * The security model in one paragraph: the browser never asserts who it is.
 * Every call carries either a Google ID token, which this script hands to
 * Google for a verified email, or a session token this script issued itself
 * after an email + password sign-in. Either way the script answers only for
 * that verified email. A student sees their own drills and their own
 * balance, and nothing else exists as far as they are concerned.
 *
 * Anyone can sign up (unless Settings > signups is "closed"). A new Google
 * account gets a roster row on first sign-in; an email + password account
 * gets one after proving it owns the address with a code sent to it. New
 * accounts start "pending" with zero credits and see nothing until the coach
 * approves them. Admin actions additionally require a Google sign-in whose
 * email is in ADMIN_EMAILS.
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

// Password sessions last this long, then the student signs in again. Six
// hours is the most CacheService will hold anything.
var SESSION_TTL = 21600;
var SESSION_PREFIX = 'drs_';

// HMAC-SHA256 rounds per password hash. Apps Script has no bcrypt, so this
// stretches the hash instead. Each round is a call into Google's runtime;
// raise it only after checking a sign-in still returns in a second or two.
var HASH_ROUNDS = 2000;


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
    configured: !!GOOGLE_CLIENT_ID,
    sheet: sheetHealth()
  });
}

// Reports whether this script can actually reach its Sheet, and which tabs
// it found. Without this, a script that verifies tokens perfectly but cannot
// open the Sheet fails only *after* sign-in, where the browser sees a generic
// "couldn't reach the server" and you cannot tell the two apart from outside.
// It exposes only tab names, which are documented in README.md anyway.
function sheetHealth() {
  var want = ['Drills', 'Events', 'Credits', 'Settings', 'Requests'];
  try {
    var ss = book();
    if (!ss) {
      return { ok: false, error: 'No spreadsheet. This script is not bound to a ' +
        'Sheet — create it from Extensions > Apps Script inside the Sheet, or set SHEET_ID.' };
    }
    var found = ss.getSheets().map(function (s) { return s.getName(); });
    var missing = want.filter(function (n) { return found.indexOf(n) === -1; });
    return {
      ok: missing.length === 0,
      found: found,
      missing: missing,
      error: missing.length ? 'Missing tabs — run setupSheet() once.' : ''
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json({ ok: false, error: 'bad request' }); }

  var action = String(body.action || '');

  // The only calls that come without an identity: they are how you get one.
  if (action === 'signupStart')  return json(signupStart(body));
  if (action === 'signupFinish') return json(signupFinish(body));
  if (action === 'login')        return json(passwordLogin(body));

  // One verification, up front, for every other action. Below this line
  // `email` is a verified fact; nothing else from the browser is trusted.
  var token = body.idToken;
  var viaGoogle = !isSessionToken(token);
  var email = viaGoogle ? verifyIdToken(token) : sessionEmail(token);
  if (!email) return json({ ok: false, error: 'signed out' });

  if (action.indexOf('admin') === 0) {
    // The dashboard stays Google-only, so a leaked password can't open it.
    if (!viaGoogle || !isAdmin(email)) return json({ ok: false, error: 'not authorised' });
    if (action === 'adminData')    return json(adminData(email));
    if (action === 'adminStatus')  return json(adminSetStatus(body.row, body.status));
    if (action === 'adminGrant')   return json(adminGrant(body.row, body.granted));
    if (action === 'adminEnroll')  return json(adminEnroll(body));
    if (action === 'adminRemove')  return json(adminRemove(body.row));
    return json({ ok: false, error: 'unknown action' });
  }

  if (action === 'logout') { endSession(token); return json({ ok: true }); }

  // Roster gate. A verified address with no row can create one; a pending or
  // revoked row is told which, and gets nothing else.
  if (action === 'register') return json(register(email, body.name));
  var s = studentRow(email);
  var blocked = notIn(s, email);
  if (blocked) return json(blocked);

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

// Sessions for email + password accounts. The token is random and lives
// only in the script cache, so it cannot be forged and dies on its own.
function isSessionToken(t) {
  return typeof t === 'string' && t.indexOf(SESSION_PREFIX) === 0;
}
function newSession(email) {
  var t = SESSION_PREFIX + randomHex(64);
  CacheService.getScriptCache().put('ses_' + digest(t), email, SESSION_TTL);
  return t;
}
function sessionEmail(t) {
  if (!isSessionToken(t) || t.length > 200) return '';
  return CacheService.getScriptCache().get('ses_' + digest(t)) || '';
}
function endSession(t) {
  if (isSessionToken(t)) CacheService.getScriptCache().remove('ses_' + digest(t));
}


/* ================= self-serve accounts ================= */

// Open unless the Settings tab has a row "signups" = "closed". Closing it
// stops new accounts; everyone already on the roster still gets in.
function signupsOpen() {
  return readSetting('signups').toLowerCase() !== 'closed';
}

// A verified address with no roster row gets one, starting at zero credits.
// Google users land here on their first sign-in.
function register(email, name) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (err) { return { ok: false, error: 'busy, try again' }; }
  try {
    if (!studentRow(email)) {
      if (!signupsOpen()) return { ok: false, error: 'signups closed', email: email };
      addStudent(email, name);
    }
  } finally {
    lock.releaseLock();
  }
  return meFor(email);
}

// Self-made accounts start as "pending": verified, on the roster, but shown
// nothing until the coach approves them. That keeps "assigned to: everyone"
// meaning everyone the coach let in, not everyone who found the site.
function addStudent(email, name) {
  name = cap(name).slice(0, 100);
  sheet('Credits').appendRow(['', 0, 0, plain(name), '', email, 'pending']);
  notifyCoach(email, name);
}

// Best effort. A failed email must not fail the sign-up; the dashboard lists
// pending accounts either way.
function notifyCoach(email, name) {
  if (!withinRate('*', 'mail', 80, 86400)) return;
  try {
    MailApp.sendEmail({
      to: ADMIN_EMAILS.join(','),
      name: 'Drill Room',
      subject: 'New Drill Room sign-up: ' + (name || email),
      body: (name || '(no name given)') + ' <' + email + '> just created an account ' +
            'and is waiting for approval.\n\n' +
            'Approve or reject: https://drills.nwatkins.org/admin.html'
    });
  } catch (err) {}
}

// Step 1 of an email + password sign-up. Nothing is written to the Sheet
// yet: the account exists only once the student types back a code sent to
// the address. Without that, anyone could put a password on someone else's
// address and walk into that person's roster row.
function signupStart(body) {
  if (!signupsOpen()) return { ok: false, error: 'signups closed' };
  var email = cleanEmail(body.email);
  if (!email) return { ok: false, error: 'Enter a valid email address.' };
  var name = cap(body.name).slice(0, 100);
  if (!name) return { ok: false, error: 'Enter your name.' };
  var bad = passwordProblem(body.password);
  if (bad) return { ok: false, error: bad };
  if (accountRow(email)) {
    return { ok: false, error: 'There is already an account for that email. Sign in instead.' };
  }

  // Every attempt sends an email and the Apps Script mail quota is small
  // (100 a day on a personal account), so cap it per address and overall.
  if (!withinRate(email, 'signup', 5, 3600) || !withinRate('*', 'mail', 80, 86400)) {
    return { ok: false, error: 'Too many attempts. Try again later.' };
  }

  var salt = randomHex(32);
  var code = String(parseInt(randomHex(8), 16) % 1000000);
  while (code.length < 6) code = '0' + code;
  CacheService.getScriptCache().put('pend_' + digest(email), JSON.stringify({
    name: name, salt: salt, hash: hashPassword(body.password, salt), code: code, tries: 0
  }), 900);

  try {
    MailApp.sendEmail({
      to: email,
      name: 'Drill Room',
      subject: 'Your Drill Room code: ' + code,
      body: 'Your code to finish creating your Drill Room account is ' + code + '.\n\n' +
            'It expires in 15 minutes. If you did not try to sign up, you can ignore this email.'
    });
  } catch (err) {
    return { ok: false, error: "Couldn't send the code email. Try again later." };
  }
  return { ok: true };
}

// Step 2: the code matches, so the address is theirs. Create the login, and
// a roster row only if they have none — a student the coach enrolled, or who
// already signs in with Google, keeps their row and credits.
function signupFinish(body) {
  var email = cleanEmail(body.email);
  var cache = CacheService.getScriptCache();
  var key = 'pend_' + digest(email);
  var raw = email && cache.get(key);
  if (!raw) return { ok: false, error: 'That code expired. Start again.' };
  var p = JSON.parse(raw);

  if (!sameString(str(body.code), p.code)) {
    p.tries++;
    if (p.tries >= 5) {
      cache.remove(key);
      return { ok: false, error: 'Too many wrong codes. Start again.' };
    }
    cache.put(key, JSON.stringify(p), 900);
    return { ok: false, error: 'That code isn\'t right. Check the email and try again.' };
  }

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (err) { return { ok: false, error: 'busy, try again' }; }
  try {
    if (accountRow(email)) {
      return { ok: false, error: 'There is already an account for that email. Sign in instead.' };
    }
    var s = studentRow(email);
    if (!s && !signupsOpen()) return { ok: false, error: 'signups closed' };
    accountsSheet().appendRow([email, p.salt, p.hash, new Date()]);
    if (!s) addStudent(email, p.name);
    cache.remove(key);
  } finally {
    lock.releaseLock();
  }
  return withSession(email);
}

function passwordLogin(body) {
  var fail = { ok: false, error: 'Wrong email or password.' };
  var email = cleanEmail(body.email);
  if (!email || typeof body.password !== 'string' || body.password.length > 200) return fail;
  if (!withinRate(email, 'login', 10, 900)) {
    return { ok: false, error: 'Too many tries. Wait 15 minutes and try again.' };
  }
  var a = accountRow(email);
  if (!a || !sameString(hashPassword(body.password, a.salt), a.hash)) return fail;
  return withSession(email);
}

function withSession(email) {
  var out = meFor(email);
  out.session = newSession(email);
  return out;
}

// The Accounts tab holds password logins only; the roster is still Credits.
// Created on first use so an existing Sheet needs no migration step.
function accountsSheet() {
  var ss = book();
  var sh = ss.getSheetByName('Accounts');
  if (sh) return sh;
  sh = ss.insertSheet('Accounts');
  sh.getRange(1, 1, 1, 4).setValues([['email', 'salt', 'password hash', 'created']])
    .setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function accountRow(email) {
  var rows = accountsSheet().getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (str(rows[i][0]).toLowerCase() === email) {
      return { row: i + 1, salt: str(rows[i][1]), hash: str(rows[i][2]) };
    }
  }
  return null;
}

// Rejects a leading = + - @ as well, since the address is written into a
// cell and Sheets would read it as a formula.
function cleanEmail(v) {
  var e = str(v).toLowerCase();
  if (e.length > 254 || /^[=+\-@]/.test(e)) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 8) return 'Use a password of at least 8 characters.';
  if (p.length > 200) return 'That password is too long.';
  return '';
}

// Iterated HMAC-SHA256, keyed by the password, seeded with the salt. Hex
// out, because base64 can start with "+" and a cell would take it as a formula.
function hashPassword(password, salt) {
  var key = Utilities.newBlob(password).getBytes();
  var h = Utilities.computeHmacSha256Signature(Utilities.newBlob(salt).getBytes(), key);
  for (var i = 1; i < HASH_ROUNDS; i++) h = Utilities.computeHmacSha256Signature(h, key);
  return h.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

// getUuid() is backed by a secure random source; Math.random() is not.
function randomHex(n) {
  var s = '';
  while (s.length < n) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, n);
}

function digest(s) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s));
}

// Compares without stopping at the first difference.
function sameString(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Anything a stranger typed that starts like a formula is stored as text.
function plain(v) {
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}


/* ================= roster ================= */

// The Credits tab is the roster. Column F (email) is what links an account to
// a row — the code in column A is a label for the coach, never a credential.
// Column G is the status: blank = active, "pending" = signed up and waiting
// for approval, "revoked" = locked out by the coach. A revoked row stays so
// they cannot simply sign up again.
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
      email: want,
      revoked: str(rows[i][6]).toLowerCase() === 'revoked',
      pending: str(rows[i][6]).toLowerCase() === 'pending'
    };
  }
  return null;
}

// The answer for anyone not yet (or no longer) allowed in, or null if they are.
function notIn(s, email) {
  if (!s) return { ok: true, enrolled: false, email: email };
  if (s.revoked) return { ok: true, enrolled: false, revoked: true, email: email };
  if (s.pending) return { ok: true, enrolled: false, pending: true, email: email, student: s.student };
  return null;
}

function meFor(email) {
  var s = studentRow(email);
  return notIn(s, email) || meResponse(s);
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
      granted: granted, used: used, left: granted - used, last: fmt(r[4]),
      revoked: str(r[6]).toLowerCase() === 'revoked',
      pending: str(r[6]).toLowerCase() === 'pending'
    });
  }
  // Waiting for approval first, then emptiest bank first.
  students.sort(function (a, b) {
    if (a.pending !== b.pending) return a.pending ? -1 : 1;
    return a.left - b.left;
  });

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

// Adds someone before they sign up (so they arrive approved, with credits),
// or approves a pending sign-up, or restores someone who was revoked.
function adminEnroll(body) {
  var email = cleanEmail(body.email);
  if (!email) return { ok: false, error: 'bad email' };
  var granted = Number(body.granted);
  if (!(granted >= 0 && granted <= 100000)) granted = 0;

  var existing = studentRow(email);
  if (existing && (existing.revoked || existing.pending)) {
    var sh = sheet('Credits');
    sh.getRange(existing.row, 7).setValue('');
    // Approving from the "add" form can carry a label and credits too.
    if (cap(body.code)) sh.getRange(existing.row, 1).setValue(plain(cap(body.code)));
    if (granted > existing.granted) sh.getRange(existing.row, 2).setValue(Math.floor(granted));
    return { ok: true, approved: true };
  }
  if (existing) return { ok: false, error: 'that address is already on the roster' };

  sheet('Credits').appendRow([
    plain(cap(body.code)), Math.floor(granted), 0, plain(cap(body.student)), '', email, ''
  ]);
  return { ok: true };
}

function adminRemove(rowNumber) {
  var sh = sheet('Credits');
  var row = Number(rowNumber);
  if (!(row >= 2 && row <= sh.getLastRow())) return { ok: false, error: 'no such row' };
  // Marked, not cleared: with open sign-up, a cleared email would just let
  // them make a fresh account. The credit history stays intact either way.
  sh.getRange(row, 7).setValue('revoked');
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
    ['Credits',  ['code', 'granted', 'used', 'student', 'last used', 'email (this is the roster)',
                  'status (blank = active, pending, revoked)'],
                 ['FALCON-07', 20, 0, 'Sebastian Alvarez', '',
                  'sebastian@example.com', '']],
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
  accountsSheet();
}

// Run once from the editor after setupSheet(), to clear the sample rows it
// created. Only those: each row is matched against the exact sample value
// first, so a row you have already replaced with real data is left alone.
// Settings/weekLabel is real config and is never touched.
function clearSampleRows() {
  var ss = book();
  var samples = [
    ['Drills',   1, 'w1-rebuttal-redo'],        // col A = id
    ['Events',   3, 'Practice round - LD'],     // col C = title
    ['Credits',  6, 'sebastian@example.com'],   // col F = email (the roster)
    ['Requests', 4, 'sebastian@example.com']    // col D = email
  ];

  var removed = [], kept = [];
  samples.forEach(function (spec) {
    var name = spec[0], col = spec[1], marker = spec[2];
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    var val = str(sh.getRange(2, col).getValue());
    if (val === marker) {
      sh.deleteRow(2);
      removed.push(name);
    } else if (val) {
      kept.push(name + ' (row 2 holds "' + val + '", not the sample)');
    }
  });

  // The default tab, if setupSheet() could not remove it earlier.
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && ss.getSheets().length > 1 && s1.getLastRow() === 0) {
    ss.deleteSheet(s1);
    removed.push('Sheet1');
  }

  var msg = 'Removed: ' + (removed.join(', ') || 'nothing') +
            (kept.length ? '  |  Left alone: ' + kept.join('; ') : '');
  Logger.log(msg);
  return msg;
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
  if (str(c.getRange(1, 7).getValue()) === '') {
    c.getRange(1, 7).setValue('status (blank = active, pending, revoked)').setFontWeight('bold');
  }
  accountsSheet();
}
