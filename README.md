# Drill Room — Watkins Debate

A single-page drill and scheduling platform for debate students. Students sign
in, work through assigned drills, book coaching sessions, request custom drills,
and submit files for review.

Everything student-facing lives in `index.html` — no build step, no
dependencies. Push to GitHub Pages and it's live.

Two optional Google integrations mean you stop redeploying the site to change
things: **booking** runs on Google Calendar, and **content** runs on a Google
Sheet. Both are free, and the site works without either.

---

## Booking

The Book a Session tab embeds a **Google Calendar appointment schedule**. Your
availability lives in Google Calendar, so you change your hours there and the
page follows immediately. Google handles timezones, DST, reminder emails, and
lets students reschedule or cancel on their own — none of which the site has to
know about.

Setup, about three minutes:

1. In Google Calendar, click **Create → Appointment schedule**.
2. Set your hours, session length, and buffer between sessions. Save.
3. Open the schedule and click **Share → Copy link**.
4. Paste that link into `BOOKING_URL` near the top of `index.html`.

Until you do, the tab shows those instructions instead of a booking widget.

Free personal Google accounts get one booking page with one appointment type,
which is all this needs. Verify current limits before relying on it.

## Live content from a Google Sheet

By default, drills, events, and credit balances are hard-coded in `index.html`,
and changing them means a commit and a redeploy. Connect `sheet-backend.gs` and
they come from a Google Sheet instead — edit the Sheet, students see it on their
next load.

It also fixes two real weaknesses of the hard-coded version:

- **Balances stop living in the student's browser.** Credits are recorded
  server-side, so clearing storage or switching browsers no longer resets them.
- **Codes stop being public.** The Sheet is queried one code at a time, so
  nobody can read the whole roster out of the page source.

Setup, about five minutes:

1. Create a Google Sheet.
2. **Extensions → Apps Script**. Delete the starter code, paste in all of
   `sheet-backend.gs`.
3. Run `setupSheet()` once from the editor toolbar. It creates the four tabs
   with headers and a sample row each. Authorize when prompted.
4. **Deploy → New deployment → Web app**, with:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the `/exec` URL into `SHEET_API` in `index.html` and redeploy the site.

The tabs it creates:

| Tab | Columns |
| --- | --- |
| `Drills` | `id`, `title`, `desc`, `time` |
| `Events` | `date` (YYYY-MM-DD), `time`, `title`, `type`, `note` |
| `Credits` | `code`, `granted`, `used`, `student`, `last used` |
| `Settings` | `key`, `value` — currently just `weekLabel` |

`type` on an event is `session`, `tournament`, or `deadline`. Bump a drill's
`id` to reset everyone's checkmark for it; keep the id and the checkmark sticks.

To give someone credits, add a row to `Credits` with their code and a `granted`
number. The script increments `used` as they spend and stamps `last used`. To
top someone up, raise `granted` — don't zero `used`, or you lose the history.

Once `SHEET_API` is set, the `DRILL_BANK` list in `index.html` is ignored
entirely. If the Sheet is ever unreachable, drills and events fall back to the
hard-coded lists, but balances are withheld rather than guessed — a student sees
"Can't reach your balance" instead of a number that might be wrong.

## Everything else

Config lives in one block at the top of the `<script>` in `index.html`:

- `COACH_EMAIL` — the footer, and the mailto fallback target.
- `FORMSPREE_ENDPOINT` — a free [Formspree](https://formspree.io) endpoint. With
  it set, sign-ups and requests land in your inbox silently. Leave `""` and the
  student's email app opens pre-filled instead.
- `WEEK_LABEL` — the label under the greeting. Overridden by the Sheet's
  `weekLabel` setting when connected.
- `DRILLS`, `EVENTS`, `DRILL_BANK` — the built-in lists, used when `SHEET_API`
  is empty.
- `PACKS` / `PURCHASE_URL` — credit packs and where the Purchase button points.

## Known limits

- **Sign-in isn't authentication.** It captures a name and email; anyone can
  type anything. Fine for a roster you already know.
- **The Apps Script URL is public.** "Anyone" access is required for the page to
  reach it. Anyone holding the URL can query a balance if they also know a valid
  code, or spend against one. Add a shared secret to the payload if that matters.
- **Without the Sheet, credits are honor-system** — they live in `localStorage`
  and reset if the student clears site data.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The entire site — markup, styles, and app logic |
| `sheet-backend.gs` | Apps Script serving drills, events, and credits from a Sheet |
| `CNAME` | Custom domain for GitHub Pages |
