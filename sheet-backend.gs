/**
 * Drill Room — serves drills, events, and drill credits from a Google Sheet.
 * Setup instructions are in README.md.
 */

var SHEET_ID = '';   // '' when the script lives inside the Sheet

// Only these accounts may open ?view=admin. Enforced on the server, so it
// holds even if someone guesses the URL.
var ADMIN_DOMAIN = 'nwatkins.org';

// OAuth client ID for student sign-in (Cloud Console > Credentials > OAuth
// client > Web application). Must match the one in index.html, or every
// token will be rejected as minted for a different site.
var GOOGLE_CLIENT_ID = '';

function doGet(e) {
  var p = (e && e.parameter) || {};

  if (p.view === 'admin') return adminPage();

  return json({
    weekLabel: readSetting('weekLabel'),
    drills: readDrills(),
    events: readEvents()
  });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'bad request' });
  }

  // Every action below identifies the caller from a Google ID token the
  // server verifies. Nothing trusts a code or an email the browser supplies.
  if (body.action === 'me')      return json(meResponse(body.idToken));
  if (body.action === 'spend')   return json(spendForToken(body.idToken));
  if (body.action === 'request') return json(saveRequest(body));

  return json({ ok: false, error: 'unknown action' });
}

/* ---------- readers ---------- */

function readDrills() {
  return rowsOf('Drills').map(function (r) {
    return { id: str(r[0]), title: str(r[1]), desc: str(r[2]), time: str(r[3]) };
  }).filter(function (d) { return d.id && d.title; });
}

function readEvents() {
  return rowsOf('Events').map(function (r) {
    return {
      date: asDate(r[0]),
      time: str(r[1]),
      title: str(r[2]),
      type: (str(r[3]) || 'session').toLowerCase(),
      note: str(r[4])
    };
  }).filter(function (ev) { return ev.date && ev.title; });
}

function readSetting(key) {
  var rows = rowsOf('Settings');
  for (var i = 0; i < rows.length; i++) {
    if (str(rows[i][0]) === key) return str(rows[i][1]);
  }
  return '';
}

/* ---------- helpers ---------- */

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
    ['Drills',   ['id', 'title', 'desc', 'time'],
                 ['w1-rebuttal-redo', '2NR redo x 3',
                  'Re-give your last practice-round 2NR three times. Third rep must finish 30 seconds under time.',
                  '45 min']],
    ['Events',   ['date (YYYY-MM-DD)', 'time', 'title', 'type (session/tournament/deadline)', 'note'],
                 ['2026-08-24', '6:00 PM', 'Practice round - LD', 'session', 'Bring your flows.']],
    ['Credits',  ['code', 'granted', 'used', 'student', 'last used', 'email'],
                 ['FALCON-07', 20, 0, 'Sebastian Alvarez', '',
                  'sebastian@example.com']],
    ['Settings', ['key', 'value'],
                 ['weekLabel', 'Week of August 17']],
    ['Requests', ['received', 'form', 'student', 'email', 'code',
                  'topic', 'category', 'details', 'needed by', 'status'],
                 [new Date(), 'file_request', 'Sebastian Alvarez',
                  'sebastian@example.com', 'FALCON-07', 'Neg - Kant NC',
                  'Review my case / blocks', 'Blocks feel thin vs util.',
                  '2026-08-27', 'open']]
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


/* ---------- coach dashboard ---------- */

// Who is calling. Blank for anonymous visitors on the public deployment,
// which is exactly what we want — they fail the domain test below.
function adminEmail() {
  try { return String(Session.getActiveUser().getEmail() || ''); }
  catch (err) { return ''; }
}

function isAdmin() {
  var e = adminEmail().toLowerCase();
  var suffix = '@' + ADMIN_DOMAIN.toLowerCase();
  return e.length > suffix.length && e.slice(-suffix.length) === suffix;
}

function saveRequest(body) {
  var email = verifyIdToken(body.idToken);
  if (!email) return { ok: false, error: 'signed out' };
  var s = studentRow(email);
  var f = body.fields || {};
  try {
    sheet('Requests').appendRow([
      new Date(),
      str(f.form),
      s ? s.student : str(f.name),
      email,
      s ? s.code : '',
      str(f.topic || f.event),
      str(f.request_type || f.skill_area),
      str(f.details || f.notes),
      str(f.needed_by),
      'open'
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Called from the dashboard via google.script.run. Re-checks the caller,
// because a check that only runs in the browser protects nothing.
function setRequestStatus(rowNumber, status) {
  if (!isAdmin()) throw new Error('Not authorised.');
  var sh = sheet('Requests');
  var row = Number(rowNumber);
  if (!(row >= 2 && row <= sh.getLastRow())) throw new Error('No such row.');
  sh.getRange(row, 10).setValue(status === 'done' ? 'done' : 'open');
  return true;
}

function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function adminPage() {
  if (!isAdmin()) {
    return HtmlService.createHtmlOutput(
      '<div style="font:15px/1.6 system-ui;padding:48px;max-width:34em;margin:auto">' +
      '<h2>Not authorised</h2><p>This dashboard is limited to <b>@' + escHtml(ADMIN_DOMAIN) +
      '</b> accounts. You are signed in as <b>' + escHtml(adminEmail() || 'nobody') + '</b>.</p>' +
      '<p>Switch Google accounts, then reload.</p></div>'
    ).setTitle('Drill Room - not authorised');
  }

  var credits  = sheet('Credits').getDataRange().getValues();
  var requests = sheet('Requests').getDataRange().getValues();
  var tz = book().getSpreadsheetTimeZone();
  var fmt = function (v) {
    return v instanceof Date ? Utilities.formatDate(v, tz, 'MMM d') : str(v);
  };

  // Drill banks, emptiest first — those are the ones about to need a refill.
  var banks = [];
  for (var i = 1; i < credits.length; i++) {
    var r = credits[i];
    if (!str(r[0])) continue;
    var granted = Number(r[1]) || 0, used = Number(r[2]) || 0;
    banks.push({
      code: str(r[0]), student: str(r[3]) || '—', email: str(r[5]),
      granted: granted, used: used, left: granted - used, last: fmt(r[4])
    });
  }
  banks.sort(function (a, b) { return a.left - b.left; });

  // Open work first, then by deadline.
  var work = [];
  for (var j = 1; j < requests.length; j++) {
    var q = requests[j];
    if (!str(q[2]) && !str(q[7])) continue;
    work.push({
      row: j + 1, received: fmt(q[0]), student: str(q[2]) || '—',
      topic: str(q[5]), category: str(q[6]), details: str(q[7]),
      due: fmt(q[8]), status: str(q[9]) || 'open'
    });
  }
  work.sort(function (a, b) {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    return String(a.due || '9999').localeCompare(String(b.due || '9999'));
  });

  var openCount = 0;
  work.forEach(function (w) { if (w.status === 'open') openCount++; });

  var h = [];
  h.push('<h1>Drill Room</h1>');
  h.push('<p class="who">' + escHtml(adminEmail()) + ' &middot; ' + openCount +
         ' open request' + (openCount === 1 ? '' : 's') + ' &middot; ' +
         banks.length + ' student' + (banks.length === 1 ? '' : 's') + '</p>');

  h.push('<h2>To do</h2>');
  if (!work.length) {
    h.push('<p class="empty">Nothing submitted yet.</p>');
  } else {
    h.push('<table><tr><th>Needed by</th><th>Student</th><th>What</th>' +
           '<th>Details</th><th>Received</th><th></th></tr>');
    work.forEach(function (w) {
      var next  = w.status === 'done' ? 'open' : 'done';
      var label = w.status === 'done' ? 'Reopen' : 'Done';
      h.push('<tr class="' + (w.status === 'done' ? 'done' : '') + '">' +
        '<td class="due">' + escHtml(w.due || '—') + '</td>' +
        '<td>' + escHtml(w.student) + '</td>' +
        '<td>' + escHtml(w.category) +
          (w.topic ? '<br><span class="sub">' + escHtml(w.topic) + '</span>' : '') + '</td>' +
        '<td class="details">' + escHtml(w.details) + '</td>' +
        '<td class="sub">' + escHtml(w.received) + '</td>' +
        '<td><button data-row="' + w.row + '" data-status="' + next + '">' +
          label + '</button></td></tr>');
    });
    h.push('</table>');
  }

  h.push('<h2>Drill banks</h2>');
  if (!banks.length) {
    h.push('<p class="empty">No codes in the Credits tab yet.</p>');
  } else {
    h.push('<table><tr><th>Student</th><th>Google account</th><th>Code</th>' +
           '<th>Left</th><th>Used</th><th>Granted</th><th>Last used</th></tr>');
    banks.forEach(function (b) {
      h.push('<tr class="' + (b.left <= 0 ? 'out' : b.left <= 3 ? 'low' : '') + '">' +
        '<td>' + escHtml(b.student) + '</td>' +
        '<td class="sub">' + (b.email ? escHtml(b.email) :
          '<span class="unlinked">not linked</span>') + '</td>' +
        '<td class="code">' + escHtml(b.code) + '</td>' +
        '<td class="left">' + b.left + '</td><td>' + b.used + '</td>' +
        '<td>' + b.granted + '</td><td class="sub">' + escHtml(b.last || '—') + '</td></tr>');
    });
    h.push('</table>');
  }

  var css =
    'body{font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;' +
      'padding:32px;color:#12161f;background:#f6f7f9}' +
    'h1{font-size:22px;margin:0}' +
    'h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;' +
      'color:#68707f;margin:34px 0 10px}' +
    '.who{color:#68707f;margin:6px 0 0;font-size:13px}' +
    '.empty{color:#68707f;background:#fff;border:1px solid #e3e6eb;' +
      'border-radius:10px;padding:20px;text-align:center}' +
    'table{width:100%;border-collapse:collapse;background:#fff;' +
      'border:1px solid #e3e6eb;border-radius:10px;overflow:hidden}' +
    'th{text-align:left;font-size:12px;text-transform:uppercase;' +
      'letter-spacing:.04em;color:#68707f;padding:10px 12px;background:#fafbfc}' +
    'td{padding:10px 12px;border-top:1px solid #eef0f3;vertical-align:top}' +
    '.sub{color:#68707f;font-size:12px}.details{max-width:32em}' +
    '.due{font-weight:600;white-space:nowrap}' +
    '.code{font-family:ui-monospace,monospace}' +
    '.left{font-weight:700}tr.low .left{color:#b26a00}tr.out .left{color:#c0392b}' +
    'tr.done td{opacity:.45}.unlinked{color:#c0392b}' +
    'button{font:inherit;font-size:13px;padding:5px 12px;border:1px solid #d3d7de;' +
      'background:#fff;border-radius:7px;cursor:pointer}' +
    'button:hover{background:#f1f3f6}button[disabled]{opacity:.5;cursor:default}';

  var js =
    'document.addEventListener("click", function (ev) {' +
    '  var b = ev.target.closest("button[data-row]"); if (!b) return;' +
    '  b.disabled = true;' +
    '  google.script.run' +
    '    .withSuccessHandler(function () { location.reload(); })' +
    '    .withFailureHandler(function (e) { b.disabled = false; alert(e.message); })' +
    '    .setRequestStatus(b.dataset.row, b.dataset.status);' +
    '});';

  return HtmlService
    .createHtmlOutput(
      '<style>' + css + '</style>' + h.join('') +
      '<scr' + 'ipt>' + js + '</scr' + 'ipt>')
    .setTitle('Drill Room - coach dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


/* ---------- who is this student ---------- */

// Verify a Google ID token with Google, not with ourselves. Returns the
// verified email, or '' for anything we could not vouch for.
//
// The client sends this token with every call. It is signed by Google and
// expires in about an hour, so a stolen one is short-lived, and nothing the
// browser claims about identity is trusted — only what comes back from here.
function verifyIdToken(idToken) {
  if (!idToken || !GOOGLE_CLIENT_ID) return '';

  // tokeninfo is a network round trip; cache the verdict briefly so a page
  // load doing three calls does not pay for three of them.
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

  // A token minted for some other site is not a login here.
  if (p.aud !== GOOGLE_CLIENT_ID) return '';
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

// Credits row for a verified email. Column F holds the student's Google
// address; the coach fills it in when handing out a code.
function studentRow(email) {
  var rows = sheet('Credits').getDataRange().getValues();
  var want = String(email).trim().toLowerCase();
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

// What the signed-in student is allowed to know: their own balance, nothing else.
function meResponse(idToken) {
  var email = verifyIdToken(idToken);
  if (!email) return { ok: false, error: 'signed out' };

  var s = studentRow(email);
  if (!s) {
    // Signed in with Google, but the coach has not linked this address to a
    // code yet. Not an error the student can fix by retrying.
    return { ok: true, found: false, email: email };
  }
  return {
    ok: true, found: true, email: email, student: s.student,
    code: s.code, granted: s.granted, used: s.used
  };
}

function spendForToken(idToken) {
  var email = verifyIdToken(idToken);
  if (!email) return { ok: false, error: 'signed out' };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (err) { return { ok: false, error: 'busy, try again' }; }

  try {
    var s = studentRow(email);
    if (!s) return { ok: false, error: 'no credits on this account' };
    if (s.granted - s.used <= 0) return { ok: false, error: 'empty' };

    var sh = sheet('Credits');
    var used = s.used + 1;
    sh.getRange(s.row, 3).setValue(used);        // C = used
    sh.getRange(s.row, 5).setValue(new Date());  // E = last used
    return { ok: true, used: used };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}
