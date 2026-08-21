/**
 * Drill Room — serves drills, events, and drill credits from a Google Sheet.
 * Setup instructions are in README.md.
 */

var SHEET_ID = '';   // '' when the script lives inside the Sheet

function doGet(e) {
  var code = e && e.parameter && e.parameter.code;
  if (code) return json(lookupCredit(code));

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
  if (body.action !== 'spend') return json({ ok: false, error: 'unknown action' });
  if (!body.code) return json({ ok: false, error: 'missing code' });

  // Serialize so two tabs can't spend the same credit twice.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json({ ok: false, error: 'busy, try again' });
  }

  try {
    var sh = sheet('Credits');
    var rows = sh.getDataRange().getValues();
    var want = String(body.code).trim().toUpperCase();

    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).trim().toUpperCase() !== want) continue;

      var granted = Number(rows[i][1]) || 0;
      var used    = Number(rows[i][2]) || 0;
      if (granted - used <= 0) return json({ ok: false, error: 'empty' });

      used += 1;
      sh.getRange(i + 1, 3).setValue(used);          // column C = used
      sh.getRange(i + 1, 5).setValue(new Date());    // column E = last used
      return json({ ok: true, used: used });
    }
    return json({ ok: false, error: 'unknown code' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- readers ---------- */

function lookupCredit(code) {
  var rows = sheet('Credits').getDataRange().getValues();
  var want = String(code).trim().toUpperCase();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toUpperCase() === want) {
      return {
        found: true,
        granted: Number(rows[i][1]) || 0,
        used: Number(rows[i][2]) || 0
      };
    }
  }
  return { found: false };
}

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
                 ['2026-09-12', '6:00 PM', 'Practice round - LD', 'session', 'Bring your flows.']],
    ['Credits',  ['code', 'granted', 'used', 'student', 'last used'],
                 ['FALCON-07', 20, 0, 'Sebastian Alvarez', '']],
    ['Settings', ['key', 'value'],
                 ['weekLabel', 'Week of September 7']]
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
