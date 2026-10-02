/* FACEIT Crosshair Board - request queue (pure state transitions)
 *
 * The queue lives in storage.local under `queue`, because the service worker it runs in
 * is killed after ~30 s idle and must resume where it left off:
 *
 *   { jobs: [Job], nextAt: { [bucket]: epochMs }, limited: { [bucket]: count },
 *     backoffUntil, failures, challenges, offline, lastSuccessAt }
 *
 *   Job = { key, type: "history", playerId, addedAt, failures }
 *       | { key, type: "match", matchId, rank, force?, addedAt, failures }
 *
 * Jobs are kept sorted: every history refresh first (cheap, and it is what discovers
 * matches), then matches by `rank`, their position in a player's history. Rank 0 is every
 * player's newest match, so a cold board fills one column at a time, newest first.
 *
 * Each endpoint family has its own rate-limit bucket, paced from the headers FACEIT sends;
 * a 429 only slows its own bucket, and only a success in that bucket clears it (`limited`).
 * A Cloudflare challenge or a network failure is not about one endpoint, so it pauses
 * everything (`backoffUntil`) and any successful request clears it.
 *
 * What the status line shows is derived (conditionOf), never stored, so it can't outlive
 * the state it describes.
 *
 * Copyright (C) 2026 Filip Tomasovych
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version. See the LICENSE file for details.
 */

import { ErrorKind } from "./api.js";

export const QUEUE_KEY = "queue";

export const JobType = Object.freeze({ HISTORY: "history", MATCH: "match" });

/** history + profile lookups (hundreds per second) vs the scoreboard (a handful per 30 s). */
export const Bucket = Object.freeze({ HISTORY: "history", SCOREBOARD: "scoreboard" });

/** What conditionOf reports for the status line; null while things work. */
export const Condition = Object.freeze({
  RATE_LIMITED: "rate_limited",
  CHALLENGE: "challenge", // a Cloudflare challenge or two; retrying
  BLOCKED: "blocked",     // CHALLENGES_UNTIL_BLOCKED in a row; still retrying, slowly
  OFFLINE: "offline",
});

export const MIN_SPACING_MS = 1000;
export const DEFAULT_SPACING_MS = { [Bucket.HISTORY]: 1000, [Bucket.SCOREBOARD]: 6000 };
export const BACKOFF_BASE_MS = 10_000;
export const BACKOFF_CAP_MS = 15 * 60 * 1000;
export const CHALLENGES_UNTIL_BLOCKED = 3;
/** A job failing this often for reasons of its own (5xx, odd body) is dropped, and the
 * worker records that (store.js errorRecord / saveHistoryFailure) so it is not re-queued
 * on every refresh. */
export const JOB_MAX_FAILURES = 3;

export const emptyQueue = () => ({
  jobs: [],
  nextAt: {},
  limited: {},
  backoffUntil: 0,
  failures: 0,
  challenges: 0,
  offline: false,
  lastSuccessAt: null,
});

/** The trouble worth showing, if any. Nothing pending means nothing is being retried. */
export function conditionOf(queue) {
  if (!queue?.jobs?.length) return null;
  if (queue.challenges >= CHALLENGES_UNTIL_BLOCKED) return Condition.BLOCKED;
  if (queue.challenges > 0) return Condition.CHALLENGE;
  if (queue.offline) return Condition.OFFLINE;
  if (Object.values(queue.limited ?? {}).some((n) => n > 0)) return Condition.RATE_LIMITED;
  return null;
}

export const bucketOf = (job) => (job.type === JobType.MATCH ? Bucket.SCOREBOARD : Bucket.HISTORY);

export const historyJob = (playerId) => ({ key: `h:${playerId}`, type: JobType.HISTORY, playerId });
/** `force` skips the fetch policy once (a click on a `login` or `error` cell). */
export const matchJob = (matchId, rank, { force = false } = {}) =>
  ({ key: `m:${matchId}`, type: JobType.MATCH, matchId, rank, ...(force && { force: true }) });

function compareJobs(a, b) {
  const ta = a.type === JobType.HISTORY ? 0 : 1;
  const tb = b.type === JobType.HISTORY ? 0 : 1;
  return ta - tb || (a.rank ?? 0) - (b.rank ?? 0) || a.addedAt - b.addedAt;
}

/**
 * Adds jobs, deduplicated by key. This is the coalescing point: any number of tabs asking
 * for the same refresh, or two players sharing a match, end up as one job. A match seen
 * again at a better rank moves up.
 */
export function enqueue(queue, jobs, now) {
  const byKey = new Map(queue.jobs.map((j) => [j.key, j]));
  for (const job of jobs) {
    const existing = byKey.get(job.key);
    if (!existing) {
      byKey.set(job.key, { ...job, addedAt: now, failures: 0 });
      continue;
    }
    let merged = existing;
    if (job.rank != null && job.rank < (existing.rank ?? Infinity)) merged = { ...merged, rank: job.rank };
    if (job.force && !existing.force) merged = { ...merged, force: true };
    if (merged !== existing) byKey.set(job.key, merged);
  }
  return { ...queue, jobs: [...byKey.values()].sort(compareJobs) };
}

/** `{ job }` to run now, `{ waitUntil }` when everything runnable is paced, or `{ idle }`. */
export function nextStep(queue, now) {
  if (!queue.jobs.length) return { idle: true };
  if (queue.backoffUntil > now) return { waitUntil: queue.backoffUntil };
  let waitUntil = Infinity;
  for (const job of queue.jobs) {
    const at = queue.nextAt[bucketOf(job)] ?? 0;
    if (at <= now) return { job };
    waitUntil = Math.min(waitUntil, at);
  }
  return { waitUntil };
}

/** How long to leave a bucket alone after a response with these rate-limit headers. */
export function spacingAfter(rateLimit, bucket) {
  const { limit, remaining, windowMs, resetMs } = rateLimit ?? {};
  if (remaining === 0) return Math.max(MIN_SPACING_MS, resetMs ?? windowMs ?? DEFAULT_SPACING_MS[bucket]);
  if (limit > 0 && windowMs > 0) return Math.max(MIN_SPACING_MS, Math.ceil(windowMs / limit));
  return DEFAULT_SPACING_MS[bucket];
}

/** Exponential backoff with "equal jitter", never shorter than the server asked for. */
export function backoffMs(failures, retryAfterMs = null, random = Math.random) {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  const jittered = exp / 2 + (random() * exp) / 2;
  return Math.min(BACKOFF_CAP_MS, Math.max(retryAfterMs ?? 0, jittered));
}

const without = (queue, job) => queue.jobs.filter((j) => j.key !== job.key);

/**
 * The job finished (fetched and stored, or skipped as no longer needed). `requested` says
 * whether a request went out, i.e. whether the bucket needs pacing. A request that got an
 * answer proves the network and Cloudflare are fine, and its bucket is not limited.
 */
export function jobDone(queue, job, { requested, rateLimit = null }, now) {
  const next = { ...queue, jobs: without(queue, job) };
  if (!requested) return next;
  const bucket = bucketOf(job);
  return {
    ...next,
    nextAt: { ...queue.nextAt, [bucket]: now + spacingAfter(rateLimit, bucket) },
    limited: { ...queue.limited, [bucket]: 0 },
    failures: 0,
    challenges: 0,
    offline: false,
    backoffUntil: 0,
    lastSuccessAt: now,
  };
}

/**
 * The job's request failed with `err` (an ApiError, or anything else). Returns the new
 * queue and whether the job was dropped for good, so the caller can record that.
 */
export function jobFailed(queue, job, err, now, random = Math.random) {
  const bucket = bucketOf(job);
  switch (err?.kind) {
    case ErrorKind.RATE_LIMITED: {
      const limited = (queue.limited?.[bucket] ?? 0) + 1;
      return {
        dropped: false,
        queue: {
          ...queue,
          limited: { ...queue.limited, [bucket]: limited },
          nextAt: { ...queue.nextAt, [bucket]: now + backoffMs(limited, err.retryAfterMs, random) },
        },
      };
    }
    case ErrorKind.CHALLENGE: {
      const failures = queue.failures + 1;
      return {
        dropped: false,
        queue: { ...queue, failures, challenges: queue.challenges + 1, backoffUntil: now + backoffMs(failures, null, random) },
      };
    }
    case ErrorKind.NETWORK: {
      const failures = queue.failures + 1;
      return { dropped: false, queue: { ...queue, failures, offline: true, backoffUntil: now + backoffMs(failures, null, random) } };
    }
    default: {
      // The job's own problem: count it against the job, pace the bucket, move on.
      const jobFailures = (job.failures ?? 0) + 1;
      const dropped = jobFailures >= JOB_MAX_FAILURES;
      const jobs = dropped
        ? without(queue, job)
        : queue.jobs.map((j) => (j.key === job.key ? { ...j, failures: jobFailures, addedAt: now } : j)).sort(compareJobs);
      return {
        dropped,
        queue: { ...queue, jobs, nextAt: { ...queue.nextAt, [bucket]: now + spacingAfter(err?.rateLimit, bucket) } },
      };
    }
  }
}
