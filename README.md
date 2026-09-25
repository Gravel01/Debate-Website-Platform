# Drill Room — Watkins Debate

A drill and scheduling platform for debate students. Students sign in with
Google, work through the drills you assigned *them*, book coaching sessions,
request custom drills, and submit files for review.

| File | Purpose |
| --- | --- |
| `index.html` | The student site |
| `admin.html` | Your dashboard — roster, open work, credits |
| `sheet-backend.gs` | Apps Script that serves everything from a Google Sheet |
| `CNAME` | Custom domain for GitHub Pages |

No build step, no dependencies. Push to GitHub Pages and it's live.

---

## How access works

**The browser never asserts who it is.** Every call to the backend carries a
Google ID token. The Apps Script hands that token to Google, gets a verified
email back, and answers only for that email. Nothing the page *claims* about
identity is trusted — not the email, not the credit code, not anything in
`localStorage`.

**There is no sign-up.** The roster is the `email` column of the `Credits`
tab. An address that isn't there signs in fine as far as Google is concerned
and is then told it isn't enrolled — it sees no drills, no events, no
balance, nothing. The only way onto the roster is you adding the address,
from the dashboard or the Sheet.

**Each student sees only their own page.** Drills and events carry an
`assigned to` column. Blank means everyone; an address means only that
person. The filtering happens on the server, after the token is verified, so
a student cannot request someone else's drills by editing anything locally.

**Until it's configured, nobody gets in.** Sign-in needs a client ID to mint
tokens and a server to check them against. Without both, `index.html` shows a
"not set up yet" notice and offers no other way in. A login checked only in
the browser would be bypassed from DevTools in seconds, so it isn't offered.

---

## Setup

Three things to create, then three values to paste. Takes about fifteen
minutes once.

### 1. The Sheet and the Apps Script

1. Create a Google Sheet.
2. **Extensions → Apps Script**. Delete the starter code, paste in all of
   `sheet-backend.gs`.
3. Run `setupSheet()` once from the editor toolbar. It creates the five tabs
   with headers and a sample row each. Authorize when prompted.
4. **Deploy → New deployment → Web app**, with:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the `/exec` URL — that's your `SHEET_API`.

"Anyone" is required and is not a hole: the endpoint answers nothing without
a verified token, and the dashboard actions additionally check the verified
email against `ADMIN_EMAILS`. There is only one deployment to manage.

### 2. The OAuth client

1. Cloud Console → **APIs & Services → Credentials → Create credentials →
   OAuth client ID → Web application**.
2. Under *Authorised JavaScript origins* add `https://drills.nwatkins.org`
   (and `http://localhost:8000` if you test locally).
3. Copy the client ID — that's your `GOOGLE_CLIENT_ID`.

### 3. Paste the values

`GOOGLE_CLIENT_ID` has to be byte-identical in all three files, or every
token is rejected as minted for a different site.

| Value | Goes in |
| --- | --- |
| `SHEET_API` | `index.html`, `admin.html` |
| `GOOGLE_CLIENT_ID` | `index.html`, `admin.html`, `sheet-backend.gs` |

Then commit and push. Redeploy the Apps Script whenever you edit the `.gs`
file — **Deploy → Manage deployments → edit → Version: New version**.

---

## The dashboard

`https://drills.nwatkins.org/admin.html`. Sign in with Google; the page holds
no data until the server has verified you.

Who can open it is `ADMIN_EMAILS` at the top of `sheet-backend.gs`:

```js
var ADMIN_EMAILS = [
  'nate.watkins@utexas.edu',
  'watkinsnate25@gmail.com'
];
```

Exact addresses, deliberately — not a domain test. Domain matching only works
if the domain is a Google Workspace domain, and `@nwatkins.org` won't match
if it's really just forwarding onto a personal Gmail. That kind of failure
gets discovered late.

The page is safe to leave public. It's an empty shell until you sign in, and
every action re-checks your token on the server, so nothing is protected by
the page being hard to find.

From it you can:

- **Add a student.** Name, the Google address they'll sign in with, an
  optional bank label, and a starting credit count. They can sign in
  immediately.
- **Revoke someone.** Clears their email, so they're locked out on their next
  page load. Their credit history stays in the Sheet.
- **Top up credits.** Raise `granted`. Don't lower it to zero out usage —
  `used` is the history.
- **Mark work done**, or reopen it.

---

## The Sheet

| Tab | Columns |
| --- | --- |
| `Drills` | `id`, `title`, `desc`, `time`, `assigned to` |
| `Events` | `date` (YYYY-MM-DD), `time`, `title`, `type`, `note`, `assigned to` |
| `Credits` | `code`, `granted`, `used`, `student`, `last used`, **`email`** |
| `Settings` | `key`, `value` — currently just `weekLabel` |
| `Requests` | `received`, `form`, `student`, `email`, `code`, `topic`, `category`, `details`, `needed by`, `status` |

`assigned to` blank means everyone. Otherwise it's one address, or several
separated by commas. `type` on an event is `session`, `tournament`, or
`deadline`. Bump a drill's `id` to reset everyone's checkmark for it; keep
the id and the checkmark sticks.

The `email` column on `Credits` is the roster. Filling it in is what creates
an account; clearing it is what removes one.

Edit the Sheet and students see it on their next load — no redeploy.

**Upgrading a Sheet from the previous version:** run `upgradeSheet()` once
from the Apps Script editor. It adds the two `assigned to` columns.

---

## Booking

The Book a Session tab embeds a **Google Calendar appointment schedule**.
Your availability lives in Google Calendar, so you change your hours there
and the page follows immediately. Google handles timezones, DST, reminder
emails, and lets students reschedule or cancel on their own.

1. In Google Calendar, click **Create → Appointment schedule**.
2. Set your hours, session length, and buffer between sessions. Save.
3. Open the schedule and click **Share → Copy link**.
4. Paste that link into `BOOKING_URL` near the top of `index.html`.

Free personal Google accounts get one booking page with one appointment type,
which is all this needs. This is already configured and working.

---

## Everything else

The rest of the config block at the top of the `<script>` in `index.html`:

- `COACH_EMAIL` — the footer, and the mailto fallback target.
- `FORMSPREE_ENDPOINT` — optional. A free [Formspree](https://formspree.io)
  endpoint, if you want a copy of each request by email on top of the Sheet.
  Leave `""` and the student's email app opens pre-filled instead.
- `PACKS` / `PURCHASE_URL` — credit packs and where the Purchase button points.

`weekLabel` comes from the Sheet's `Settings` tab.

---

## Known limits

- **Drill checkmarks are per-device.** They live in `localStorage`, keyed to
  the verified email, so they don't follow a student to another browser and
  you can't see them. Moving them server-side would mean a Sheet write on
  every checkbox click.
- **A revoked student keeps their current page until they reload.** The next
  call to the server fails and drops them to the sign-in screen. There is no
  push.
- **Anyone holding the `/exec` URL can call it.** They get `signed out` for
  everything without a valid token, which is the point, but the URL itself
  isn't a secret and shouldn't be treated as one.
- **`ADMIN_EMAILS` lives in the Apps Script**, not the Sheet. Changing it
  means editing the `.gs` file and redeploying.
