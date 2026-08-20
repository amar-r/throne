# Changelog

## Unreleased

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
