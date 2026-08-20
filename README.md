# THRONE

Self-hosted single-user toilet-trip tracker. How long you were there, whether
anything happened, and how much of that time you actually needed.

The number it exists to report is **wasted minutes**: time spent sitting on the
toilet that accomplished nothing. A trip where nothing happened is wasted in
full. A trip where something happened is wasted in proportion to how little of
the sitting was actually productive — a twenty-minute trip with two minutes of
pooping counts as eighteen minutes gone.

Third in a set with [Wheezer](../wheeze-tracker) (:8420) and
[Snooze](../sleep-tracker) (:8430). Same shape: one Express file, one HTML file,
a JSON array on disk, no build step, no database, no login.

## Running it

```bash
npm install
npm start
```

Then open <http://localhost:8440>. On a phone, use the machine's LAN address —
that is what it is designed for.

With Docker:

```bash
mkdir -p data          # so the bind mount isn't created root-owned
docker compose up -d
```

`compose.yaml` pulls the published image; `docker-compose.yml` builds from this
checkout.

## Using it

Tap **START** when you sit down. The trip is written to disk immediately and
stays open, so the running clock survives a reload and shows up on every device
on the network — start on your phone, finish on your laptop if you like.

Tap **DONE** when you're finished and answer three questions: did you actually
poop, how much of that time was actually pooping, and what else you were doing.
Nothing is saved until you answer — dismissing the sheet leaves the trip running.

Forgot to tap START on time? **Edit** next to the running clock corrects the
start time and the clock re-anchors. Forgot to tap it at all? **Log a trip I
forgot** backfills one.

## Things it deliberately does not do

**It never auto-closes a forgotten trip.** Writing an end time you never
observed would mean fabricating the exact number the app exists to report.
A trip left open just stays open, and is excluded from every average until you
say how it went. After three hours the screen stops showing a live clock and
offers to finish or discard it instead.

**It never guesses an answer.** A trip with no answer to "did you poop" is not
recorded as a no. It stays unanswered and stays out of the statistics.

**It has no login.** Put it on a LAN or a VPN, not on the open internet.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8440` | Port to listen on |
| `DATA_DIR` | `./data` | Where `entries.json` lives |
| `MAX_ENTRIES` | `50000` | Ceiling on stored trips, so a stuck client can't fill the disk |

## Your data

One JSON array at `DATA_DIR/entries.json`. Readable, greppable, and yours —
back it up by copying the file. `/api/export` and `/api/export/csv` produce a
download; the CSV carries the derived columns, computed by the same module the
screen renders from, so the two can never disagree.

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/entries` | All trips, newest first |
| `POST` | `/api/entries` | Start a trip (empty body) or backfill a finished one |
| `POST` | `/api/entries/:id/complete` | Finish the running trip |
| `PUT` | `/api/entries/:id` | Full replace — the edit sheet |
| `DELETE` | `/api/entries/:id` | Delete |
| `GET` | `/api/health` | `{status, version}` |
| `GET` | `/api/export`, `/api/export/csv` | Downloads |

## License

MIT.
