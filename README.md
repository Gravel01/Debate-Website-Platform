# Drill Room — Watkins Debate

A single-page drill and scheduling platform for debate students. Students sign in,
work through assigned drills, request custom drills, submit files for review, and
**book coaching sessions from your real availability** — Acuity-style.

Everything lives in `index.html`. No build step, no dependencies. Push to GitHub
Pages and it's live.

---

## How booking works

You define your availability once, in the `BOOKING` block near the top of the
`<script>` in `index.html`. Students only ever see times you've opened:

```js
const BOOKING = {
  scriptUrl: "",                    // Google Apps Script URL (see below)
  slotMinutes: 60,                  // session length
  daysAhead: 30,                    // how far out students can book
  minNoticeHours: 12,               // blocks last-minute bookings
  timezone: "America/Chicago",      // YOUR timezone; all times below are in it
  timezoneLabel: "Central Time (US)",
  weekly: {                         // 0=Sun, 1=Mon ... 6=Sat
    1: ["16:00","17:00","18:00"],   // Mondays 4/5/6pm
    3: ["16:00","17:00","18:00"],   // Wednesdays
    6: ["10:00","11:00","13:00"]    // Saturdays
  },
  extra:   { "2026-08-30": ["13:00"] },  // one-off added availability
  blocked: [ "2026-09-01" ]              // days off (overrides weekly)
};
```

Dates with no availability are greyed out and unclickable. Times inside the
notice window, past the booking horizon, or already taken never appear as
options.

Times are anchored to `timezone`, not the student's browser. A student in
another timezone still sees your slots correctly and gets their own local time
shown alongside ("5:00 PM · Mon 6:00 PM your time"). Daylight saving is handled.

## Connecting your Google Calendar

Without a backend, bookings arrive as email and you add them yourself. With the
backend connected, a booking is **written straight to your Google Calendar**, the
student is sent a calendar invitation, and the slot disappears for everyone else.

1. Go to <https://script.google.com> → **New project**.
2. Delete the starter code, paste in all of `booking-backend.gs`, save.
3. Edit the `CONFIG` block at the top (calendar, timezone, optional Zoom link).
   Keep `CONFIG.timezone` identical to `BOOKING.timezone` in `index.html`.
4. **Deploy → New deployment → Web app**, with:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Authorize when prompted, then copy the `/exec` URL.
6. Paste it into `BOOKING.scriptUrl` in `index.html` and redeploy the site.

The backend also reads your existing calendar entries, so anything already on
your calendar — not just drill bookings — blocks the overlapping slots. Two
students clicking the same time at once is handled with a lock; the loser is
told to pick again.

If the backend is ever unreachable, booking falls back to email automatically
rather than failing.

## Other configuration

All in the same config block at the top of the `<script>`:

- `COACH_EMAIL` — used for the footer and the mailto fallback.
- `FORMSPREE_ENDPOINT` — a free [Formspree](https://formspree.io) form endpoint.
  With it set, sign-ups and requests land in your inbox silently. Leave `""` to
  open the student's email app instead.
- `WEEK_LABEL` — the label under the greeting.
- `DRILLS` — this week's assigned drills. Bump the `id` prefix (`w1-` → `w2-`)
  to reset everyone's checkmarks for a new week.
- `DRILL_BANK` — drill credits, keyed by code rather than by student, since this
  file is public. Hand each student their code privately; they enter it once.
- `EVENTS` — the "Upcoming" list under the booking calendar.
- `PACKS` / `PURCHASE_URL` — credit packs and where the Purchase button points.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The entire site — markup, styles, and app logic |
| `booking-backend.gs` | Google Apps Script that writes bookings to your calendar |
| `CNAME` | Custom domain for GitHub Pages |
