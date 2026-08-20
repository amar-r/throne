# Changelog

## Unreleased

Both compose files now require `TZ` and refuse to start without it.

A trip is stamped with the server's wall clock the moment you tap START and
stored as a local-time string carrying no offset. Neither compose file set a
timezone, so a container took the image default of UTC and wrote a 10pm trip as
2am the following day. Because the stamp carries no offset, nothing downstream
could detect it: `dayKey` grouped the history under the wrong date and `byHour`
bucketed it at the wrong hour, and the damage was in the file rather than on
screen — reading it back on a correctly configured instance would not have
recovered the real time.

Compose now errors out naming the variable instead of falling back to UTC.
Defaulting would have been a guess about when something happened, which is the
one thing this app refuses to do everywhere else.

## 0.1.0

First version.

Tracks toilet trips as a two-step session: tap START when you sit down and the
trip is written to disk immediately, tap DONE when you're finished and answer
what happened. Because the open trip lives on disk rather than in the tab, the
running clock survives a reload and appears on every device on the network.

Reports wasted time as the headline figure — duration weighted by how much of
the sitting was actually productive, so a long trip with a brief result counts
as mostly wasted rather than fully successful.

Deliberately refuses to guess: a forgotten trip is never auto-closed, an
unanswered question is never defaulted to an answer, and neither one is allowed
to reach an average.
