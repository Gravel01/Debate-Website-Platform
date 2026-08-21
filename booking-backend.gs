/**
 * Drill Room — booking backend (Google Apps Script)
 *
 * What this does:
 *   • GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD  → returns the times you're
 *          already busy, so those slots disappear for students
 *   • POST {action:"book", date, time, minutes, name, email, notes}
 *          → creates the event on YOUR Google Calendar and emails the
 *            student a calendar invitation. Returns {ok:true}.
 *
 * SETUP (about five minutes)
 *   1. Go to https://script.google.com → New project.
 *   2. Delete the starter code, paste this whole file in, and save.
 *   3. Edit CONFIG below (calendar id, session title, timezone).
 *   4. Deploy → New deployment → type "Web app".
 *        Execute as:        Me
 *        Who has access:    Anyone
 *      Click Deploy, authorize when prompted, and copy the /exec URL.
 *   5. Paste that URL into BOOKING.scriptUrl in index.html and redeploy
 *      the site. Bookings now appear on your calendar automatically.
 *
 * Note: the availability itself (which days and times students can pick)
 * lives in BOOKING.weekly / extra / blocked in index.html. This script
 * only records bookings and reports which slots are already taken.
 */

var CONFIG = {
  // "primary" = your main Google Calendar. To use a separate calendar,
  // paste its Calendar ID from Google Calendar → Settings → Integrate calendar.
  calendarId: 'primary',

  eventTitle: 'Drill session',      // student's name gets appended
  location: '',                     // e.g. a Zoom link
  timezone: 'America/Chicago',

  // Invite the student to the calendar event (they get an email invite
  // and it lands on their own calendar). Set false to keep it private.
  inviteStudent: true,

  // Also email yourself a plain notification for each booking.
  notifyEmail: ''                   // leave '' to skip
};

function doGet(e) {
  var from = (e && e.parameter && e.parameter.from) || ymd(new Date());
  var to   = (e && e.parameter && e.parameter.to)   || ymd(addDays(new Date(), 60));
  var cal  = getCal();
  var events = cal.getEvents(startOfDay(from), addDays(startOfDay(to), 1));

  // Any event on the calendar makes overlapping slots unbookable, so a
  // dentist appointment blocks a drill slot the same way a booking does.
  var busy = events
    .filter(function (ev) { return !ev.isAllDayEvent(); })
    .map(function (ev) {
      return {
        s: Utilities.formatDate(ev.getStartTime(), CONFIG.timezone, "yyyy-MM-dd'T'HH:mm"),
        e: Utilities.formatDate(ev.getEndTime(),   CONFIG.timezone, "yyyy-MM-dd'T'HH:mm")
      };
    });

  return json({ busy: busy });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'bad request' });
  }

  if (body.action !== 'book') return json({ ok: false, error: 'unknown action' });
  if (!body.date || !body.time || !body.name || !body.email) {
    return json({ ok: false, error: 'missing fields' });
  }

  // Serialize bookings so two students can't grab the same slot.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json({ ok: false, error: 'busy, try again' });
  }

  try {
    var minutes = Number(body.minutes) || 60;
    var start = parseSlot(body.date, body.time);
    var end   = new Date(start.getTime() + minutes * 60000);
    var cal   = getCal();

    // Already taken?
    var clashes = cal.getEvents(start, end);
    if (clashes.length > 0) return json({ ok: false, error: 'taken' });

    var options = {
      description: [
        'Booked via Drill Room.',
        'Student: ' + body.name + ' <' + body.email + '>',
        body.notes ? 'Wants to work on: ' + body.notes : ''
      ].filter(String).join('\n'),
      location: CONFIG.location
    };
    if (CONFIG.inviteStudent) {
      options.guests = body.email;
      options.sendInvites = true;
    }

    cal.createEvent(CONFIG.eventTitle + ' — ' + body.name, start, end, options);

    if (CONFIG.notifyEmail) {
      MailApp.sendEmail(
        CONFIG.notifyEmail,
        'New drill session booked — ' + body.name,
        [
          body.name + ' (' + body.email + ') booked a session.',
          '',
          'When: ' + Utilities.formatDate(start, CONFIG.timezone, 'EEEE, MMMM d') +
            ' at ' + Utilities.formatDate(start, CONFIG.timezone, 'h:mm a'),
          'Length: ' + minutes + ' minutes',
          'Notes: ' + (body.notes || 'none')
        ].join('\n')
      );
    }

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- helpers ---------- */

function getCal() {
  return CONFIG.calendarId === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CONFIG.calendarId);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// "2026-09-14" + "16:00" → Date at that wall-clock time in CONFIG.timezone.
// The offset is read off the date itself, so DST is handled automatically.
function parseSlot(dateStr, timeStr) {
  return new Date(dateStr + 'T' + timeStr + ':00' + tzOffset(dateStr));
}

// Offset like "-05:00" for the given date in CONFIG.timezone.
function tzOffset(dateStr) {
  var z = Utilities.formatDate(new Date(dateStr + 'T12:00:00Z'), CONFIG.timezone, 'Z'); // "-0500"
  return z.slice(0, 3) + ':' + z.slice(3);
}

function startOfDay(dateStr) {
  return parseSlot(dateStr, '00:00');
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}
function ymd(d) {
  return Utilities.formatDate(d, CONFIG.timezone, 'yyyy-MM-dd');
}
