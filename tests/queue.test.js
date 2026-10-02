// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Bucket, Condition, BACKOFF_CAP_MS, CHALLENGES_UNTIL_BLOCKED, JOB_MAX_FAILURES,
  emptyQueue, enqueue, nextStep, spacingAfter, backoffMs, jobDone, jobFailed, historyJob, matchJob, conditionOf,
} from "../src/lib/queue.js";
import { ApiError, ErrorKind } from "../src/lib/api.js";

const NOW = 1_000_000;
const keys = (q) => q.jobs.map((j) => j.key);

test("enqueue: history first, then matches by rank, deduplicated", () => {
  let q = enqueue(emptyQueue(), [matchJob("a1", 1), matchJob("b0", 0), historyJob("p")], NOW);
  q = enqueue(q, [matchJob("a0", 0), matchJob("b0", 0), historyJob("p")], NOW + 1);
  assert.deepEqual(keys(q), ["h:p", "m:b0", "m:a0", "m:a1"]);
});

test("enqueue: a match seen at a better rank moves up", () => {
  let q = enqueue(emptyQueue(), [matchJob("x", 5), matchJob("y", 2)], NOW);
  q = enqueue(q, [matchJob("x", 0)], NOW);
  assert.deepEqual(keys(q), ["m:x", "m:y"]);
  assert.equal(q.jobs[0].rank, 0);
});

test("nextStep: idle, paced buckets and global backoff", () => {
  assert.deepEqual(nextStep(emptyQueue(), NOW), { idle: true });
  const q = enqueue(emptyQueue(), [historyJob("p"), matchJob("m", 0)], NOW);
  assert.equal(nextStep(q, NOW).job.key, "h:p");
  // History paced, scoreboard open: the match runs first.
  const paced = { ...q, nextAt: { [Bucket.HISTORY]: NOW + 500 } };
  assert.equal(nextStep(paced, NOW).job.key, "m:m");
  const both = { ...q, nextAt: { [Bucket.HISTORY]: NOW + 500, [Bucket.SCOREBOARD]: NOW + 200 } };
  assert.deepEqual(nextStep(both, NOW), { waitUntil: NOW + 200 });
  assert.deepEqual(nextStep({ ...q, backoffUntil: NOW + 9 }, NOW), { waitUntil: NOW + 9 });
});

test("spacingAfter follows the headers", () => {
  assert.equal(spacingAfter({ limit: 5, remaining: 4, windowMs: 30000 }, Bucket.SCOREBOARD), 6000);
  assert.equal(spacingAfter({ limit: 10, remaining: 8, windowMs: 20000 }, Bucket.SCOREBOARD), 2000);
  assert.equal(spacingAfter({ limit: 350, remaining: 349, windowMs: 1000 }, Bucket.HISTORY), 1000, "floor");
  assert.equal(spacingAfter({ limit: 5, remaining: 0, windowMs: 30000, resetMs: 12000 }, Bucket.SCOREBOARD), 12000);
  assert.equal(spacingAfter(null, Bucket.SCOREBOARD), 6000);
});

test("backoffMs: grows, jitters, caps, honours retry-after", () => {
  assert.equal(backoffMs(1, null, () => 0), 5000);
  assert.equal(backoffMs(1, null, () => 1), 10000);
  assert.equal(backoffMs(3, null, () => 1), 40000);
  assert.equal(backoffMs(50, null, () => 1), BACKOFF_CAP_MS);
  assert.equal(backoffMs(1, 60000, () => 0), 60000);
  assert.equal(backoffMs(1, 10 * BACKOFF_CAP_MS, () => 0), BACKOFF_CAP_MS);
});

test("enqueue: force is kept when the same match is queued again", () => {
  let q = enqueue(emptyQueue(), [matchJob("m", 3)], NOW);
  q = enqueue(q, [matchJob("m", 0, { force: true })], NOW);
  assert.equal(q.jobs[0].force, true);
  q = enqueue(q, [matchJob("m", 5)], NOW);
  assert.equal(q.jobs[0].force, true, "a plain re-queue doesn't drop it");
});

const failed = (q, job, err, random = () => 1) => jobFailed(q, job, err, NOW, random);

test("jobDone paces the bucket only when a request went out, and clears trouble", () => {
  const q0 = { ...enqueue(emptyQueue(), [matchJob("m", 0), matchJob("n", 1)], NOW), failures: 2, challenges: 2 };
  const skipped = jobDone(q0, q0.jobs[0], { requested: false }, NOW);
  assert.deepEqual(keys(skipped), ["m:n"]);
  assert.equal(conditionOf(skipped), Condition.CHALLENGE, "still pending, still retrying");
  const done = jobDone(q0, q0.jobs[0], { requested: true, rateLimit: { limit: 5, remaining: 4, windowMs: 30000 } }, NOW);
  assert.equal(done.nextAt[Bucket.SCOREBOARD], NOW + 6000);
  assert.equal(conditionOf(done), null);
  assert.equal(done.challenges, 0);
  assert.equal(done.lastSuccessAt, NOW);
});

test("conditionOf: nothing pending means nothing to report", () => {
  const q0 = enqueue(emptyQueue(), [historyJob("p")], NOW);
  const challenged = failed(q0, q0.jobs[0], new ApiError(ErrorKind.CHALLENGE)).queue;
  assert.equal(conditionOf(challenged), Condition.CHALLENGE);
  // The player is removed during the backoff: the job is skipped without a request.
  const emptied = jobDone(challenged, challenged.jobs[0], { requested: false }, NOW);
  assert.equal(conditionOf(emptied), null);
});

test("jobFailed: 429 slows only its bucket and keeps the job", () => {
  const q0 = enqueue(emptyQueue(), [matchJob("m", 0)], NOW);
  const { queue: q, dropped } = failed(q0, q0.jobs[0], new ApiError(ErrorKind.RATE_LIMITED, { retryAfterMs: 30000 }), () => 0);
  assert.equal(dropped, false);
  assert.equal(conditionOf(q), Condition.RATE_LIMITED);
  assert.equal(q.nextAt[Bucket.SCOREBOARD], NOW + 30000);
  assert.equal(q.backoffUntil, 0);
  assert.deepEqual(keys(q), ["m:m"]);
});

test("a success in another bucket doesn't clear a 429, and backoff keeps growing", () => {
  let q = enqueue(emptyQueue(), [matchJob("m", 0), historyJob("p")], NOW);
  const match = q.jobs.find((j) => j.key === "m:m");
  const history = q.jobs.find((j) => j.key === "h:p");
  q = failed(q, match, new ApiError(ErrorKind.RATE_LIMITED)).queue;
  q = failed(q, match, new ApiError(ErrorKind.RATE_LIMITED)).queue;
  q = jobDone(q, history, { requested: true }, NOW);
  assert.equal(conditionOf(q), Condition.RATE_LIMITED);
  q = failed(q, match, new ApiError(ErrorKind.RATE_LIMITED)).queue;
  assert.equal(q.nextAt[Bucket.SCOREBOARD], NOW + 40000, "third 429 in that bucket: 10 s * 2^2");
  q = jobDone(q, match, { requested: true }, NOW);
  assert.equal(conditionOf(q), null);
});

test("jobFailed: challenges back off globally and turn into blocked", () => {
  let q = enqueue(emptyQueue(), [matchJob("m", 0)], NOW);
  const conditions = [];
  for (let i = 0; i < CHALLENGES_UNTIL_BLOCKED; i++) {
    q = failed(q, q.jobs[0], new ApiError(ErrorKind.CHALLENGE)).queue;
    conditions.push(conditionOf(q));
  }
  assert.deepEqual(conditions, [Condition.CHALLENGE, Condition.CHALLENGE, Condition.BLOCKED]);
  assert.equal(q.backoffUntil, NOW + 40000);
  assert.deepEqual(keys(q), ["m:m"], "the match is retried, never dropped");
});

test("jobFailed: network errors mean offline", () => {
  const q0 = enqueue(emptyQueue(), [historyJob("p")], NOW);
  const { queue: q } = failed(q0, q0.jobs[0], new ApiError(ErrorKind.NETWORK), () => 0);
  assert.equal(conditionOf(q), Condition.OFFLINE);
  assert.ok(q.backoffUntil > NOW);
});

test("jobFailed: a job's own errors move it back, then drop it and say so", () => {
  let q = enqueue(emptyQueue(), [matchJob("bad", 0), matchJob("good", 0)], NOW);
  let out = jobFailed(q, q.jobs[0], new ApiError(ErrorKind.HTTP, { status: 500 }), NOW + 1);
  q = out.queue;
  assert.equal(out.dropped, false);
  assert.deepEqual(keys(q), ["m:good", "m:bad"], "no head-of-line blocking");
  for (let i = 1; i < JOB_MAX_FAILURES; i++) {
    out = jobFailed(q, q.jobs.find((j) => j.key === "m:bad"), new ApiError(ErrorKind.HTTP), NOW + 1);
    q = out.queue;
  }
  assert.equal(out.dropped, true);
  assert.deepEqual(keys(q), ["m:good"]);
  assert.equal(conditionOf(q), null);
});
