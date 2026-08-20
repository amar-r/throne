// Everything derived from a stored trip lives here, and only here.
//
// A trip stores nothing but two timestamps and three answers. Duration, wasted
// time, success rate and the rest are computed on read, so correcting a formula
// later corrects every trip already on disk instead of only the ones logged
// after the fix.
//
// This file is loaded two ways — `require`d by server.js for the CSV export and
// <script src>'d by index.html for the UI — so the number on the stats screen
// and the number in the spreadsheet can never drift apart. That matters more
// here than in a normal app: the headline figure is entirely derived, so a
// second implementation would mean two different answers to the only question
// this app exists to answer.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThroneMetrics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // How much of the sitting was actually pooping. Stored as a word rather than
  // a number so the stored record stays readable by eye, and so the buckets can
  // be re-weighted later without rewriting every entry on disk.
  var FRACTIONS = { none: 0, little: 0.25, half: 0.5, most: 0.8, all: 1 };
  var FRACTION_LABELS = {
    none: 'None of it',
    little: 'A little',
    half: 'About half',
    most: 'Most of it',
    all: 'The whole time'
  };
  var FRACTION_ORDER = ['none', 'little', 'half', 'most', 'all'];

  // A trip open longer than this has almost certainly been forgotten rather
  // than being genuinely in progress. Past it the UI stops showing a live
  // clock — see the comment on the recovery card in index.html. It is not an
  // env knob on purpose: it changes what the screen says, not how the app is
  // deployed.
  var STALE_OPEN_MINUTES = 180;

  // Local-time parse of `YYYY-MM-DDTHH:mm[:ss]`, the shape a `datetime-local`
  // input produces. Deliberately not `new Date(string)`: that treats a
  // seconds-less datetime as UTC in some engines and local in others, which
  // would shift every trip by the timezone offset depending on the browser.
  // Building the Date from parts is unambiguous.
  function parseLocal(s) {
    if (typeof s !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0);
    // Rejects things like 2026-02-31, which the Date constructor would happily
    // roll over into March.
    if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) {
      return null;
    }
    return d;
  }

  // Seconds are kept, unlike in the sibling apps. A trip is minutes long, so
  // truncating to the minute can lose a tenth of a short one — and short trips
  // are exactly the false alarms this app is trying to count.
  function toLocalString(d) {
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function start(e) { return e ? parseLocal(e.startedAt) : null; }
  function end(e) { return e ? parseLocal(e.endedAt) : null; }

  // "Open" is the absence of an end time, never a stored status field. A status
  // field would be a second source of truth that can contradict `endedAt`, and
  // every consumer here would then have to decide which one to believe. This
  // way the answer is derived and cannot disagree with itself.
  function isOpen(e) { return !!start(e) && !end(e); }
  function isComplete(e) { return !!start(e) && !!end(e); }

  function completed(list) { return (list || []).filter(isComplete); }
  function openEntry(list) { return (list || []).find(isOpen) || null; }

  function durationSeconds(e) {
    if (!isComplete(e)) return null;
    return (end(e) - start(e)) / 1000;
  }

  // The live clock only. Floored at zero so a phone whose clock is behind the
  // one that recorded the start shows 0:00 rather than counting backwards.
  // Deliberately never fed into an aggregate: a trip that is still running has
  // no duration yet, and treating "so far" as "how long it took" would make
  // every average drift upward for as long as the tab stays open.
  function elapsedSeconds(e, now) {
    var s = start(e);
    if (!s) return 0;
    return Math.max(0, ((now === undefined ? Date.now() : now) - s) / 1000);
  }

  function isStale(e, now) {
    return isOpen(e) && elapsedSeconds(e, now) > STALE_OPEN_MINUTES * 60;
  }

  // How much of the trip counted for anything.
  //
  // No result means no credit, however long you sat there. Where you did poop,
  // the answer to "how much of the time?" decides it. An entry with no answer
  // reads as fully productive rather than as zero — that fallback is what keeps
  // a trip logged before the question existed from having its number rewritten
  // underneath it.
  function productiveFraction(e) {
    if (!e || e.pooped !== true) return 0;
    var f = FRACTIONS[e.productivity];
    return f === undefined ? 1 : f;
  }

  function wastedSeconds(e) {
    var d = durationSeconds(e);
    if (d === null) return null;
    return d * (1 - productiveFraction(e));
  }

  function productiveSeconds(e) {
    var d = durationSeconds(e);
    if (d === null) return null;
    return d * productiveFraction(e);
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  // The running clock: M:SS under an hour, H:MM:SS above.
  function formatClock(seconds) {
    var s = Math.max(0, Math.floor(seconds || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    function p(n) { return String(n).padStart(2, '0'); }
    if (h > 0) return h + ':' + p(m) + ':' + p(sec);
    return m + ':' + p(sec);
  }

  // Prose durations for the list and the stats. Under a minute stays in
  // seconds, because "0m" for a 40-second false alarm reads as a bug.
  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return '—';
    var s = Math.round(seconds);
    if (s < 60) return s + 's';
    var h = Math.floor(s / 3600);
    var m = Math.round((s % 3600) / 60);
    if (h > 0) {
      if (m === 60) { h += 1; m = 0; }
      return m ? h + 'h ' + m + 'm' : h + 'h';
    }
    return Math.round(s / 60) + 'm';
  }

  function formatPercent(fraction) {
    if (fraction === null || fraction === undefined || !isFinite(fraction)) return '—';
    return Math.round(fraction * 100) + '%';
  }

  // ---------------------------------------------------------------------------
  // Aggregates
  //
  // Every one of these takes an already-filtered list of COMPLETE trips. Open
  // trips are excluded before they get here, so a session left running for a
  // week contributes nothing to any average — which is what makes it safe to
  // never auto-close one.
  // ---------------------------------------------------------------------------

  function dayKey(e) {
    return typeof e.startedAt === 'string' ? e.startedAt.slice(0, 10) : '';
  }

  function sum(list, fn) {
    return list.reduce(function (acc, e) {
      var v = fn(e);
      return acc + (typeof v === 'number' && isFinite(v) ? v : 0);
    }, 0);
  }

  function median(values) {
    var v = values.filter(function (n) { return typeof n === 'number' && isFinite(n); })
      .sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  // Calendar days actually covered by the trips in hand, counted by re-anchoring
  // each day key to local midnight rather than dividing a millisecond delta —
  // a DST change makes one day 23 or 25 hours long and would round the division
  // to the wrong integer.
  function daysSpanned(list) {
    var keys = list.map(dayKey).filter(Boolean).sort();
    if (!keys.length) return 0;
    var first = parseLocal(keys[0] + 'T00:00:00');
    var last = parseLocal(keys[keys.length - 1] + 'T00:00:00');
    if (!first || !last) return 0;
    return Math.round((last - first) / 86400000) + 1;
  }

  function summarize(list) {
    var trips = list.length;
    var totalSeconds = sum(list, durationSeconds);
    var wastedTotalSeconds = sum(list, wastedSeconds);
    var days = daysSpanned(list);
    var successes = list.filter(function (e) { return e.pooped === true; }).length;

    return {
      trips: trips,
      days: days,
      totalSeconds: totalSeconds,
      wastedTotalSeconds: wastedTotalSeconds,
      productiveTotalSeconds: totalSeconds - wastedTotalSeconds,
      wastedShare: totalSeconds > 0 ? wastedTotalSeconds / totalSeconds : null,
      successRate: trips > 0 ? successes / trips : null,
      falseAlarms: list.filter(function (e) { return e.pooped === false; }).length,
      medianSeconds: median(list.map(durationSeconds)),
      longestSeconds: trips ? Math.max.apply(null, list.map(durationSeconds)) : null,
      tripsPerDay: days > 0 ? trips / days : null,
      wastedPerDay: days > 0 ? wastedTotalSeconds / days : null,
      // A projection from the observed daily rate, not a measured week. The UI
      // labels it as such rather than presenting it as something that happened.
      wastedPerWeek: days > 0 ? (wastedTotalSeconds / days) * 7 : null
    };
  }

  // Wasted seconds across the trips that started in [from, to).
  function wastedBetween(list, from, to) {
    return list.reduce(function (acc, e) {
      var s = start(e);
      if (!s || s < from || s >= to) return acc;
      var w = wastedSeconds(e);
      return acc + (typeof w === 'number' && isFinite(w) ? w : 0);
    }, 0);
  }

  // The last seven days against the seven before them.
  //
  // Anchored to local midnight rather than to "now minus 168 hours", so the
  // comparison doesn't slide by a few minutes every time the page is opened —
  // a trip would otherwise drift across the boundary between two refreshes and
  // change the answer without anything having been logged.
  //
  // `hasPrevious` is reported separately because an empty prior week is not a
  // 100% improvement, it is an absence of data, and the two must not render the
  // same way.
  function weekOverWeek(list, now) {
    var end = new Date(now === undefined ? Date.now() : now);
    end.setHours(0, 0, 0, 0);
    end = new Date(end.getTime() + 86400000);
    var mid = new Date(end.getTime() - 7 * 86400000);
    var begin = new Date(mid.getTime() - 7 * 86400000);

    var current = wastedBetween(list, mid, end);
    var previous = wastedBetween(list, begin, mid);
    var hasPrevious = list.some(function (e) {
      var s = start(e);
      return s && s >= begin && s < mid;
    });

    return {
      current: current,
      previous: previous,
      delta: current - previous,
      hasPrevious: hasPrevious
    };
  }

  function byHour(list) {
    var buckets = [];
    for (var i = 0; i < 24; i++) buckets.push({ hour: i, trips: 0, seconds: 0, wasted: 0 });
    list.forEach(function (e) {
      var s = start(e);
      if (!s) return;
      var b = buckets[s.getHours()];
      b.trips++;
      b.seconds += durationSeconds(e) || 0;
      b.wasted += wastedSeconds(e) || 0;
    });
    return buckets;
  }

  function byWeekday(list) {
    var buckets = [];
    for (var i = 0; i < 7; i++) buckets.push({ weekday: i, trips: 0, seconds: 0, wasted: 0 });
    list.forEach(function (e) {
      var s = start(e);
      if (!s) return;
      var b = buckets[s.getDay()];
      b.trips++;
      b.seconds += durationSeconds(e) || 0;
      b.wasted += wastedSeconds(e) || 0;
    });
    return buckets;
  }

  // Each activity gets credited with the trip's FULL duration, not a split
  // share. Dividing 17 minutes between "phone" and "just sitting" would invent
  // a precision that was never entered — nobody logged which minutes were
  // which. The question worth answering is "how much toilet time involves my
  // phone", and full attribution answers exactly that. The consequence is that
  // these rows sum to more than the total when trips carry two tags, so the UI
  // labels the column rather than presenting it as a breakdown of a whole.
  function byActivity(list) {
    var map = new Map();
    list.forEach(function (e) {
      var tags = Array.isArray(e.doing) ? e.doing : [];
      tags.forEach(function (tag) {
        if (!map.has(tag)) map.set(tag, { label: tag, trips: 0, seconds: 0, wasted: 0 });
        var b = map.get(tag);
        b.trips++;
        b.seconds += durationSeconds(e) || 0;
        b.wasted += wastedSeconds(e) || 0;
      });
    });
    return Array.from(map.values()).sort(function (a, b) { return b.wasted - a.wasted; });
  }

  return {
    FRACTIONS: FRACTIONS,
    FRACTION_LABELS: FRACTION_LABELS,
    FRACTION_ORDER: FRACTION_ORDER,
    STALE_OPEN_MINUTES: STALE_OPEN_MINUTES,
    parseLocal: parseLocal,
    toLocalString: toLocalString,
    start: start,
    end: end,
    isOpen: isOpen,
    isComplete: isComplete,
    isStale: isStale,
    completed: completed,
    openEntry: openEntry,
    durationSeconds: durationSeconds,
    elapsedSeconds: elapsedSeconds,
    productiveFraction: productiveFraction,
    wastedSeconds: wastedSeconds,
    productiveSeconds: productiveSeconds,
    formatClock: formatClock,
    formatDuration: formatDuration,
    formatPercent: formatPercent,
    dayKey: dayKey,
    median: median,
    daysSpanned: daysSpanned,
    summarize: summarize,
    wastedBetween: wastedBetween,
    weekOverWeek: weekOverWeek,
    byHour: byHour,
    byWeekday: byWeekday,
    byActivity: byActivity
  };
});
