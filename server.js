const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { version } = require('./package.json');
const M = require('./public/metrics.js');

const app = express();
const PORT = process.env.PORT || 8440;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'entries.json');

// Refuse to keep growing the data file without bound. At a handful of trips a
// day this is decades — it's here so a stuck client or a loop on the network
// can't fill the disk.
const MAX_ENTRIES = Number(process.env.MAX_ENTRIES || 50000);

// Ensure data dir/file exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

// Never fall back to an empty list here. Returning [] on a parse failure and
// then letting a later write persist it is a silent, unrecoverable wipe of
// every trip. Throwing instead leaves the bad file untouched on disk, so it
// stays recoverable by hand.
function readEntries() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch (e) {
    throw new Error(
      `${DATA_FILE} is not valid JSON (${e.message}). Refusing to read or ` +
      `overwrite it so your trips stay recoverable — repair or move the file, ` +
      `then restart.`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${DATA_FILE} does not contain a JSON array. Refusing to overwrite it.`);
  }
  return parsed;
}

function writeEntries(entries) {
  // atomic-ish write: write to temp file then rename
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Any read failure means we must not write: reply 500 and leave the file be.
function dataError(res, e) {
  console.error(e.message);
  res.status(500).json({ error: e.message });
}

// Ids arrive from the URL as strings, so always compare stringified.
const sameId = (a, b) => String(a) === String(b);

// Newest first, by when the trip started. The frontend leans on this ordering
// for the history list, and the open trip is normally element 0.
function sortEntries(entries) {
  entries.sort((a, b) => {
    const x = String(a.startedAt || '');
    const y = String(b.startedAt || '');
    return x < y ? 1 : x > y ? -1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Validation
//
// A bad trip is worse here than a missing one: every figure on the stats screen
// is an average or a total, so one 40-hour trip or one negative duration
// silently distorts what the page says about every other trip rather than
// showing up as an obvious hole. So the shape is checked on the way in, and
// anything that can't be true is refused rather than stored and worked around.
// ---------------------------------------------------------------------------

class ValidationError extends Error {}

const MAX_NOTES = 2000;
const MAX_DOING = 12;
const MAX_DOING_LABEL = 40;
const MAX_TRIP_HOURS = 24;

// Phone clocks drift, and the phone that taps Start is often not the machine
// running this. A couple of minutes of slack absorbs that; beyond it, a
// timestamp in the future is a typo or a wrong date.
const FUTURE_SKEW_MINUTES = 2;

const EARLIEST = new Date(2000, 0, 1);

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function requireTime(value, label) {
  const d = M.parseLocal(value);
  if (!d) throw new ValidationError(`${label} must be a date and time like 2026-08-19T14:02:37`);
  if (d < EARLIEST) throw new ValidationError(`${label} is implausibly far in the past`);
  if (d.getTime() > Date.now() + FUTURE_SKEW_MINUTES * 60 * 1000) {
    throw new ValidationError(`${label} is in the future — check the date`);
  }
  return d;
}

function optionalTime(value, label) {
  if (isBlank(value)) return null;
  return requireTime(value, label);
}

// The chip list in the UI is a convenience, not a schema — an "other" value
// typed by hand is just as valid, so labels are cleaned rather than checked
// against an allowlist. Everything here is escaped again on render.
function normalizeDoing(raw) {
  if (isBlank(raw)) return [];
  if (!Array.isArray(raw)) throw new ValidationError('doing must be a list');
  const out = [];
  raw.forEach((item) => {
    const label = String(item === null || item === undefined ? '' : item)
      .trim().slice(0, MAX_DOING_LABEL);
    if (!label) return;
    if (!out.includes(label)) out.push(label);
  });
  if (out.length > MAX_DOING) {
    throw new ValidationError(`No more than ${MAX_DOING} activities on one trip`);
  }
  return out;
}

function normalizeProductivity(raw) {
  if (isBlank(raw)) return '';
  const v = String(raw).trim();
  if (!Object.prototype.hasOwnProperty.call(M.FRACTIONS, v)) {
    throw new ValidationError(
      `productivity must be one of ${M.FRACTION_ORDER.join(', ')}`
    );
  }
  return v;
}

// `pooped` is tri-state. `null` means the question hasn't been answered yet,
// which is the honest state of a trip that is still running. Defaulting it to
// false would make a browser that crashed mid-trip indistinguishable from a
// genuine false alarm — and a false alarm counts as 100% wasted time, so the
// app would be inventing its own headline number.
function normalizePooped(raw, isOpenTrip) {
  if (isOpenTrip) return null;
  if (raw === true || raw === false) return raw;
  throw new ValidationError('Say whether you actually pooped');
}

function checkSpan(startedAt, endedAt) {
  // Equal is allowed: tapping Start and immediately Done is a real zero-length
  // false alarm, and it is exactly the kind of trip worth counting.
  if (endedAt < startedAt) {
    throw new ValidationError('That end time is before the trip started — fix the start time first');
  }
  const hours = (endedAt - startedAt) / (60 * 60 * 1000);
  if (hours > MAX_TRIP_HOURS) {
    throw new ValidationError(
      `That trip spans more than ${MAX_TRIP_HOURS} hours — check the date on the end time`
    );
  }
}

// Build the stored record field by field rather than spreading the request
// body: the file stays exactly the shape this app knows how to read, and a
// client can't park arbitrary keys (or its own `id`) in it.
function normalizeEntry(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Expected a trip object');

  // Start defaults to now, which is what the one-tap START button relies on:
  // it posts an empty body and lets the server stamp it. Using the server's
  // clock for both ends means a phone whose clock is off can't record an end
  // before its own start.
  const startedAt = isBlank(body.startedAt) ? new Date() : requireTime(body.startedAt, 'Start time');
  const endedAt = optionalTime(body.endedAt, 'End time');
  if (endedAt) checkSpan(startedAt, endedAt);

  const open = !endedAt;

  return {
    startedAt: M.toLocalString(startedAt),
    endedAt: endedAt ? M.toLocalString(endedAt) : '',
    pooped: normalizePooped(body.pooped, open),
    productivity: open ? '' : normalizeProductivity(body.productivity),
    doing: open ? [] : normalizeDoing(body.doing),
    notes: isBlank(body.notes) ? '' : String(body.notes).slice(0, MAX_NOTES)
  };
}

// A narrower normaliser for finishing a trip that is already on disk. It reads
// only the fields the completion sheet asks about and takes `startedAt` from
// the stored record rather than from the request — a phone that loaded before
// the start time was corrected on another device would otherwise send back the
// stale value and silently revert the correction.
function completeEntry(body, existing) {
  if (!body || typeof body !== 'object') throw new ValidationError('Expected a completion object');

  const startedAt = M.parseLocal(existing.startedAt);
  if (!startedAt) throw new ValidationError('That trip has an unreadable start time — edit it first');

  const endedAt = isBlank(body.endedAt) ? new Date() : requireTime(body.endedAt, 'End time');
  checkSpan(startedAt, endedAt);

  return {
    startedAt: existing.startedAt,
    endedAt: M.toLocalString(endedAt),
    pooped: normalizePooped(body.pooped, false),
    productivity: normalizeProductivity(body.productivity),
    doing: normalizeDoing(body.doing),
    notes: isBlank(body.notes) ? '' : String(body.notes).slice(0, MAX_NOTES),
    id: existing.id
  };
}

function validationError(res, e) {
  if (e instanceof ValidationError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  return false;
}

// A trip is two timestamps and a handful of short answers, so 32kb is generous
// for one and well under Express's 100kb default — a client can't push large
// payloads at us.
app.use(express.json({ limit: '32kb' }));

// Everything the page loads is served from this origin, and the app makes no
// third-party requests at all, so this policy is exactly true rather than
// aspirational. 'unsafe-inline' is unavoidable while index.html keeps its
// <script>/<style> blocks inline, which blunts the anti-XSS value — but
// connect-src still stops injected code from shipping your history off to
// another host, and frame-ancestors blocks clickjacking.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// GET all trips, newest first
app.get('/api/entries', (req, res) => {
  try {
    res.json(readEntries());
  } catch (e) {
    dataError(res, e);
  }
});

// POST a new trip.
//
// Serves two flows. An empty body is the START button: the server stamps the
// start and leaves the trip open. A body carrying both timestamps and the
// answers is a trip being backfilled after the fact, which is already finished
// and so doesn't touch the one-open rule at all.
app.post('/api/entries', (req, res) => {
  let entry;
  try {
    entry = normalizeEntry(req.body);
  } catch (e) {
    if (validationError(res, e)) return;
    throw e;
  }

  try {
    const entries = readEntries();
    if (entries.length >= MAX_ENTRIES) {
      return res.status(507).json({
        error: `Trip limit reached (${MAX_ENTRIES}). Delete old trips or raise MAX_ENTRIES.`
      });
    }

    // At most one trip may be open at a time. Two open trips would make "the
    // trip you're on" ambiguous for the timer, the Done button and the
    // recovery card alike.
    //
    // This check is genuinely atomic rather than merely probabilistically safe:
    // one Node process, synchronous fs, and no `await` anywhere between the
    // read above and the write below, so two phones tapping START in the same
    // second serialise. That is why there is no lock file here.
    if (!entry.endedAt) {
      const open = entries.find(e => M.isOpen(e));
      if (open) {
        return res.status(409).json({
          error: 'A trip is already running. Finish or discard it first.',
          existingId: open.id
        });
      }
    }

    // id last: the body must never be able to choose its own id, or a client
    // can collide with (and later delete) an existing trip.
    const saved = { ...entry, id: randomUUID() };
    entries.unshift(saved);
    sortEntries(entries);
    writeEntries(entries);
    res.status(201).json(saved);
  } catch (e) {
    dataError(res, e);
  }
});

// POST the end of a running trip.
//
// A dedicated route rather than a PUT, for three reasons. The one-tap path can
// send `{}` and let the server stamp the end with the same clock that stamped
// the start. A full PUT would need the phone to echo back `startedAt`, which
// silently reverts a correction made elsewhere since that phone last loaded.
// And finishing a trip that is already finished can be a 409 here, instead of a
// second write quietly replacing a real end time with "now" — the classic
// double-tap on a laggy connection.
app.post('/api/entries/:id/complete', (req, res) => {
  try {
    const entries = readEntries();
    const idx = entries.findIndex(e => sameId(e.id, req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Trip not found' });

    const existing = entries[idx];
    if (!M.isOpen(existing)) {
      return res.status(409).json({
        error: 'That trip is already finished.',
        existingId: existing.id
      });
    }

    let finished;
    try {
      finished = completeEntry(req.body, existing);
    } catch (e) {
      if (validationError(res, e)) return;
      throw e;
    }

    entries[idx] = finished;
    sortEntries(entries);
    writeEntries(entries);
    res.json(finished);
  } catch (e) {
    dataError(res, e);
  }
});

// PUT a full replacement — the edit sheet, for correcting a start time tapped
// late or fixing up a finished trip.
app.put('/api/entries/:id', (req, res) => {
  let entry;
  try {
    entry = normalizeEntry(req.body);
  } catch (e) {
    if (validationError(res, e)) return;
    throw e;
  }

  try {
    const entries = readEntries();
    const idx = entries.findIndex(e => sameId(e.id, req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Trip not found' });

    // An edit must not be a back door around the one-open rule: reopening a
    // finished trip while another is already running would leave two.
    if (!entry.endedAt) {
      const open = entries.find(e => M.isOpen(e) && !sameId(e.id, req.params.id));
      if (open) {
        return res.status(409).json({
          error: 'Another trip is already running. Finish or discard it first.',
          existingId: open.id
        });
      }
    }

    // Keep the stored id: the URL says which trip this is, not the body.
    const saved = { ...entry, id: entries[idx].id };
    entries[idx] = saved;
    sortEntries(entries);
    writeEntries(entries);
    res.json(saved);
  } catch (e) {
    dataError(res, e);
  }
});

app.delete('/api/entries/:id', (req, res) => {
  try {
    const entries = readEntries();
    const remaining = entries.filter(e => !sameId(e.id, req.params.id));
    if (remaining.length === entries.length) {
      return res.status(404).json({ error: 'Trip not found' });
    }
    writeEntries(remaining);
    res.status(204).end();
  } catch (e) {
    dataError(res, e);
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version });
});

app.get('/api/export', (req, res) => {
  let entries;
  try {
    entries = readEntries();
  } catch (e) {
    return dataError(res, e);
  }
  const payload = { exportedAt: new Date().toISOString(), entries };
  const filename = `throne-trips-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload, null, 2));
});

function csvEscape(val) {
  if (val === undefined || val === null) return '';
  let s = String(val);
  // Excel/Sheets treat a leading =, +, - or @ as a formula, so a note like
  // "=HYPERLINK(...)" would execute on open. Prefix with an apostrophe to
  // force it back to plain text.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get('/api/export/csv', (req, res) => {
  let entries;
  try {
    entries = readEntries();
  } catch (e) {
    return dataError(res, e);
  }

  const columns = [
    'id', 'startedAt', 'endedAt', 'open', 'durationMinutes', 'pooped',
    'productivity', 'productiveFraction', 'wastedMinutes', 'doing', 'notes'
  ];
  const rows = [columns.join(',')];

  // Derived columns come from the same module the page renders from, so a
  // number checked against the screen always matches.
  for (const e of entries) {
    const duration = M.durationSeconds(e);
    const wasted = M.wastedSeconds(e);
    const row = {
      id: e.id,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      open: M.isOpen(e) ? 'yes' : 'no',
      // An open trip has no duration yet, so these stay blank rather than
      // reporting a partial figure as if it were final.
      durationMinutes: duration === null ? '' : (duration / 60).toFixed(2),
      pooped: e.pooped === true ? 'yes' : e.pooped === false ? 'no' : '',
      productivity: e.productivity || '',
      productiveFraction: M.isComplete(e) ? M.productiveFraction(e) : '',
      wastedMinutes: wasted === null ? '' : (wasted / 60).toFixed(2),
      doing: Array.isArray(e.doing) ? e.doing.join('; ') : '',
      notes: e.notes || ''
    };
    rows.push(columns.map(col => csvEscape(row[col])).join(','));
  }

  const filename = `throne-trips-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'text/csv');
  res.send(rows.join('\n'));
});

app.listen(PORT, () => {
  console.log(`THRONE listening on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
