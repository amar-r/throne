# Contributing

THRONE is a single-user app that runs on a home network and stores its data in
one JSON file. Almost every constraint below follows from that.

## Constraints

**One runtime dependency.** Express. No devDependencies. If a change needs a
library, the change is probably wrong for this app — the sibling trackers hold
the same line and both are more featureful than they look.

**No build step.** `public/` is served off disk. A bundler would buy nothing and
would cost the ability to edit a file and hit reload.

**No framework.** Vanilla DOM, template literals, delegated listeners. The whole
UI is a few hundred lines of straightforward code; a framework would be more
machinery than the thing it renders.

**No database.** A JSON array is legible, greppable, trivially backed up, and
fast enough for a lifetime of trips. The API is shaped so it could become SQLite
without the frontend noticing, but it hasn't needed to.

**No login.** Single user, LAN or VPN. Don't add auth; put it behind a network
boundary instead.

**No test suite, no linter.** `node -c` and hand-testing. See CLAUDE.md.

## Style

Two-space indent, semicolons, single quotes, `const`/`let`, arrow callbacks,
template literals for HTML.

Comments explain **why**, in full prose sentences, and name the specific failure
being prevented. This is the most distinctive thing about the codebase and the
easiest to erode. A comment that restates the code is worse than none.

## Data honesty

The app reports a number about the reader's own behaviour, so it must never
invent one. Concretely: don't auto-close forgotten trips, don't default an
unanswered question to an answer, don't let an in-progress trip contribute to an
average, and don't clamp an out-of-range time into range — reject it and say
which end looked wrong. If a change makes a statistic look tidier by guessing at
something the user didn't enter, it's the wrong change.

## Releases

The git tag makes the release. Don't bump `package.json` per commit — a release
is a separate bookkeeping commit plus a `v*.*.*` tag, and CI fails a tag that
disagrees with `package.json`.

Every user-visible change gets a `CHANGELOG.md` entry under `## Unreleased`,
written as prose about what was wrong and why it mattered.
