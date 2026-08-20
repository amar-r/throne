# Working on THRONE

Self-hosted single-user toilet-trip tracker. Express 5, one `server.js`, one
`public/index.html`, a JSON array on disk. Sibling to Wheezer (:8420) and
Snooze (:8430); this one is :8440.

## Shape

- `server.js` — the whole backend. Routes inline, no routers, no `src/`.
- `public/metrics.js` — every derived number. UMD, so `server.js` requires it
  for the CSV export and the page loads it with `<script src>`. One definition,
  two consumers, no drift.
- `public/index.html` — the whole frontend. Inline `<style>` and `<script>`,
  vanilla DOM, no build. Served off disk, so edit and reload is the dev loop.
  Only `server.js` and `metrics.js` changes need a restart.

There is no test suite and no linter. `node -c` on both JS files is the syntax
check; everything else is verified by hand (see below).

## Invariants worth not breaking

- **`readEntries()` throws** on unparseable or non-array JSON rather than
  returning `[]`. Returning `[]` and then letting a later write persist it is a
  silent, unrecoverable wipe.
- **Writes go to a temp file then rename.** A half-written `entries.json` is
  worse than a stale one.
- **`id` is assigned by the server and spread last.** A client that picks its
  own id can collide with, and later delete, an existing trip.
- **At most one trip is open at a time**, enforced in `POST /api/entries` and in
  `PUT /api/entries/:id`. The check is atomic because the process is single and
  the fs calls are synchronous — do not introduce an `await` between the read
  and the write, or the guarantee quietly becomes a race.
- **Open is `endedAt === ''`**, never a status field. A status field is a second
  source of truth that can contradict the timestamp.
- **`pooped` is tri-state.** `null` means unanswered. Never default it to
  `false`; a false alarm counts as fully wasted time, so defaulting would let
  the app invent its own headline number.
- **Nothing is ever auto-closed.** A forgotten trip stays open forever and stays
  out of every aggregate. Writing an end time nobody observed is fabrication.
- **The live timer recomputes from the stored start every tick, never
  accumulates.** `setInterval` is throttled in background tabs and stops while
  a phone is locked, so a counter would under-report exactly the long trips this
  app exists to measure.
- **Aggregates only ever see complete trips.** `M.completed(list)` first.
- **Everything user-entered is `escapeHtml()`d on render**, including "other"
  activity labels.
- **List actions are delegated** via `data-action`/`data-id`. Never interpolate
  an id into inline JS.
- **Element ids are the contract** between the markup and the script. Renaming
  one silently breaks whatever reads it.
- No bundler, no framework, no TypeScript, no login. One runtime dependency.

## Timestamps

Local wall-clock strings, `YYYY-MM-DDTHH:mm:ss`. Never UTC, never epoch, never
`toISOString()` on a stored record — it shifts the clock by the timezone offset.
Parse with `M.parseLocal`, format with `M.toLocalString`.

Seconds are kept, unlike in the sibling apps. Trips are minutes long, so
truncating to the minute loses a meaningful slice of a short one — and short
trips are exactly the false alarms worth counting.

Date arithmetic re-anchors with `M.parseLocal(key + 'T00:00:00')`, never by
dividing a millisecond delta: DST makes one day 23 or 25 hours long.

## Changing the waste formula

`productiveFraction()` in `metrics.js` is the single place that decides what
counts as wasted. Everything downstream — the hero number, the CSV, the charts —
follows from it. The `undefined -> 1` fallback for a missing `productivity` is
what stops a formula change from retroactively rewriting trips logged before the
question existed. Keep that property.

## Verifying a change

No browser automation here. Run a second instance so the real data file is never
at risk:

```bash
mkdir -p /tmp/throne-preview
curl -s http://localhost:8440/api/entries > /tmp/throne-preview/entries.json
DATA_DIR=/tmp/throne-preview PORT=8441 node server.js
```

Then exercise the flows with `curl` (start; a second start must 409 with
`existingId`; complete; completing twice must 409; end-before-start must 400;
`{"id":"pwned"}` must not survive; a corrupted `entries.json` must 500 and leave
the file byte-identical), and check the screen on a real phone over the LAN.
The phone cases that matter: reload mid-trip, lock and unlock, and finishing on
another device while the phone is backgrounded.
