# IEEE-VIT Enrollments API (2025-26)

Express + **Postgres (Neon)** backend for the IEEE-VIT enrollments website.
Data access uses Drizzle ORM. Sign-in uses **Google Identity Services**, not
Firebase. The frontend lives in the `IEEE-Enrollments` repository.

## How enrollment works

| Stage | What happens | Where it's enforced |
|---|---|---|
| **Login** | "Sign in with Google". Only verified `@vitstudent.ac.in` accounts can register. | `controllers/user.controller.js#login` |
| **1. Application** | Candidate fills the form (phone, links, first/second-choice domain, questions, one management scenario). | `submitApplication` |
| **2. Task** | On submit, a **random active task from the first-choice domain** is assigned with a **48h deadline** (configurable). Late submissions are rejected. If the domain has no task yet, the candidate waits and is assigned automatically when an admin adds one. | `services/task.service.js` |
| **3. Slot booking** | After submitting the task, the candidate books an interview slot. Slots have a **capacity** and close when full. Booking runs in a transaction with row locks and a `booked_count <= capacity` CHECK constraint, so a slot can't be overbooked. | `services/slot.service.js` |
| **4. Meeting link** | **30 minutes** (configurable) before the slot the link is emailed and shown on the dashboard. Bookings can be changed until then. | `services/meetingLink.service.js` |

Admins (allow-listed emails) manage tasks, slots, links, reviews and settings
from the admin panel at `/thedarkside`.

## Project structure

```
server.js            entry point: env check, DB connect + migrations, HTTP server, scheduler
app.js               Express app (middleware + routes), importable by tests
config/env.js        every environment variable, with defaults
config/enrollment.js domains, form questions, management scenarios
db/schema.js         Postgres tables (Drizzle)
db/index.js          connection: Neon via node-postgres, or in-memory PGlite
drizzle/             SQL migrations generated from db/schema.js
services/            business rules (task assignment, booking, meeting links, settings)
controllers/         request handlers (user, admin, public/cron)
routes/              URL -> controller mapping
middleware/          authentication / authorisation
lib/                 sessions, Google token check, mail, validation, helpers
scripts/             migrate, seed, cron runner, in-memory dev server
tests/               Vitest + Supertest integration tests (in-memory Postgres)
render.yaml          Render blueprint (web service + cron job)
```

## Local development

```bash
npm install
cp .env.example .env   # set DATABASE_URL (Neon), secrets, admin emails
npm run dev            # http://localhost:5000 - applies migrations on start
npm run seed           # optional: sample tasks + slots
```

**Signing in locally.** You have two options:
- Set `DEV_LOGIN=true` to log in with just an email, without a Google account.
  This is for local testing only; the server refuses to start in production
  with it on.
- Set `GOOGLE_CLIENT_ID` to use real Google sign-in. See "Google sign-in setup"
  below.

**Want a throw-away database instead of Neon?**
`npm run dev:memory -- --seed` runs the same server on an in-memory Postgres
with sample data and dev login switched on. It never touches Neon.

Without `MAIL_USER`/`MAIL_PASS`, emails are logged to the console instead of sent.

## Database & migrations

- The tables are defined in `db/schema.js`.
- After changing the schema, run `npm run db:generate`. This writes a new SQL
  file to `drizzle/`; commit it.
- Migrations are applied automatically when the server starts. To apply them
  manually, run `npm run db:migrate`.
- `npm run db:studio` opens Drizzle Studio for browsing data.

## Tests

```bash
npm test
```

69 integration tests run the real Express app against an in-memory Postgres
(PGlite), so your Neon data is never touched. They cover:
- VIT-only login, Google token checks and admin allow-lists
- form validation, including double submits
- random task assignment and deadlines
- concurrent booking: no overbooking and no double booking
- the meeting-link dispatcher: timing, idempotency, retries and link changes
- admin permissions, CSV export and settings

The booking race was also verified against real Neon Postgres: 8 candidates
raced for 2 seats, and exactly 2 succeeded.

## Environment variables

See [.env.example](.env.example). The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon pooled connection string (`sslmode=verify-full`) |
| `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET` | JWT secrets (long random strings) |
| `GOOGLE_CLIENT_ID` | OAuth Web client ID for "Sign in with Google" |
| `DEV_LOGIN` | `true` = email-only login for local testing (never in production) |
| `ALLOWED_EMAIL_DOMAIN` | Candidate email domain, default `vitstudent.ac.in` |
| `SUPERADMIN_EMAILS` / `ADMIN_EMAILS` | Comma-separated admin allow-lists |
| `CLIENT_ORIGINS`, `APP_URL` | Frontend URL(s) for CORS and email links |
| `MAIL_USER`, `MAIL_PASS` | Gmail address + App Password for emails |
| `CRON_SECRET` | Protects `POST /api/cron/meeting-links` |

**Roles.** *Superadmins* can do everything: tasks, slot creation and deletion,
settings, deadline extensions, removing bookings and CSV export. *Admins* can
view candidates, record reviews, set meeting links, join slots as an interviewer
and send links. Removing an email from the allow-list revokes access immediately.

## Google sign-in setup

1. In Google Cloud Console, go to **APIs & Services > OAuth consent screen**.
   Set it up as *External* with the app name and a support email.
2. Go to **Credentials > Create credentials > OAuth client ID**, application type
   **Web application**.
3. Under **Authorized JavaScript origins**, add `http://localhost:5173` and your
   Vercel URL (for example `https://enrollments.ieeevit.org`).
4. Put the client ID in `GOOGLE_CLIENT_ID`. The frontend reads it from
   `/api/config`, so you only set it on the backend. The client secret and
   redirect URIs are not used by this flow, so keep the secret out of `.env`.

## Deploying on Render

1. In Render, choose **New > Blueprint** and select this repo (it uses `render.yaml`:
   free plan, **Singapore** region), or create a **Web Service** by hand: build
   `npm ci --omit=dev`, start `npm start`, health check `/api/health`, region
   Singapore (same as Neon).
2. Set the secrets: `DATABASE_URL`, `GOOGLE_CLIENT_ID`, admin emails, mail
   credentials, and `CLIENT_ORIGINS`/`APP_URL` (your Vercel URL). Do **not**
   set `DEV_LOGIN`.
3. Put the Render URL into the frontend's `vercel.json` rewrite.

## Free tier: keeping things awake

Expected load: about 50 slots and 100 students a day. The free tiers handle
that easily. The only thing to manage is *sleeping*:

- **Render (keep awake).** Free services sleep after 15 minutes idle, and the
  first request then waits about a minute. Point an external cron (cron-job.org,
  UptimeRobot, ...) at `GET https://<your-render-url>/api/health` **every 10
  minutes**.
  - This endpoint never touches the database.
  - Staying awake all month uses about 744 of Render's 750 free hours per
    workspace, so keep this the only free Render service.
- **Neon (let it sleep).** Neon's free plan has 100 compute-hours a month and
  suspends after 5 idle minutes. It wakes in well under a second, so it should
  *not* be kept awake. Running 24/7 would use about 180 hours, and Neon would
  suspend the database mid-month.
  - Don't ping the database from the cron. `/api/health/db` exists for
    one-off checks only.
  - In the Neon console, set the compute to a fixed 0.25 CU (autoscaling
    min = max = 0.25) so heavy moments can't burn hours faster.
- **Background jobs don't wake Neon.** The meeting-link scheduler checks every
  minute but only queries the database when a link is actually due. Pages that
  auto-refresh pause while their browser tab is hidden.

**Meeting-link emails** go out from the in-process scheduler, which runs every
minute while the service is awake. You can also point the cron at
`POST /api/cron/meeting-links` (with `Authorization: Bearer $CRON_SECRET`) as a
backup. Like the scheduler, it's a no-op unless a link is due, and duplicates
are impossible either way. (`npm run cron:meeting-links` runs one dispatch
directly against the database, e.g. from a paid Render Cron Job.)

**Email volume:** a Gmail account can send about 500 emails a day. Each
candidate gets about 3 (task, booking, link), so 100 a day fits.

## API overview

All responses are `{ success, message?, data? }`. IDs are UUIDs.

**Public:** `GET /api/health` (no DB), `GET /api/health/db`, `GET /api/server-time`, `GET /api/config`,
`POST /api/cron/meeting-links` (cron secret).

**Candidate** (`/api/user`): `POST /` login (`{ credential, deviceId }` from
Google, or `{ devEmail, devName, deviceId }` with dev login), `GET /` current
state, `POST /refresh-token`, `POST /logout`, `GET /application/form`,
`POST /application`, `POST /task`, `GET /slots`, `POST /slots/:slotId/book`,
`DELETE /booking`.

**Admin** (`/api/admin`): `POST /` login, `GET /`, `GET /stats`,
`GET /candidates`, `GET /candidates/export`, `GET /candidates/:id`,
`PUT /candidates/:id/interview`, `PUT /candidates/:id/task-deadline`,
`DELETE /candidates/:id/booking`, `GET|POST /tasks`, `PUT|DELETE /tasks/:id`,
`GET|POST /slots`, `PUT|DELETE /slots/:id`, `POST /slots/:id/interviewers/me`,
`POST /slots/:id/send-links`, `GET|PUT /settings`.

---

## Candidate Data Exporter (Python)

A CLI script to export participant data (personal details, domains, candidate projects, assigned recruitment tasks, interview slots, reviews, and Q&A) to styled Excel (`.xlsx`) or CSV (`.csv`) files directly from PostgreSQL.

### Setup
```bash
pip install -r scripts/requirements.txt
```

### Usage
```bash
# Export to Excel (.xlsx)
npm run export:candidates
# or: python scripts/export_candidates.py

# Export to CSV
python scripts/export_candidates.py --format csv

# Custom output destination
python scripts/export_candidates.py -o ./candidates.xlsx

# Filter by domain or stage
python scripts/export_candidates.py --domain "Web Development"
python scripts/export_candidates.py --stage task

# Demo preview without database connection
python scripts/export_candidates.py --demo
```

