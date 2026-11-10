import type { WalkthroughDocument } from "@sentry/junior/api/schema";
import { withMockPermalinks } from "./walkthrough-permalinks";

const file = "packages/junior/src/chat/automations/run-lock.ts";

/** A fixed single-PR bug fix on its first review, for the Walkthrough prototype. */
export function readMockBugFixWalkthrough(): WalkthroughDocument {
  return withMockPermalinks({
    schemaVersion: 1,
    versionId: "wt_bf_v1",
    contentVersionId: "wt_bf_v1",
    repository: "getsentry/junior",
    layers: [
      {
        pr: 3150,
        title: "Stop scheduled automations from running twice after a deploy",
        url: "https://github.com/getsentry/junior/pull/3150",
        headSha: "5be21c9",
        baseSha: "0d4f7aa",
        additions: 38,
        deletions: 6,
      },
    ],
    hunks: [
      {
        id: "lock-key",
        pr: 3150,
        path: file,
        language: "ts",
        lines: [
          {
            kind: "context",
            content: "function runLockKey(run: ScheduledRun) {",
            oldLine: 21,
            newLine: 21,
          },
          {
            kind: "remove",
            content:
              "  return `${run.automationId}:${process.env.VERCEL_DEPLOYMENT_ID}`;",
            oldLine: 22,
          },
          {
            kind: "add",
            content:
              "  return `${run.automationId}:${run.scheduledFor.toISOString()}`;",
            newLine: 22,
          },
          { kind: "context", content: "}", oldLine: 23, newLine: 23 },
        ],
      },
      {
        id: "run-now",
        pr: 3150,
        path: "packages/junior/src/chat/automations/run-now.ts",
        language: "ts",
        lines: [
          {
            kind: "context",
            content: "const run = {",
            oldLine: 40,
            newLine: 40,
          },
          {
            kind: "context",
            content: "  automationId: automation.id,",
            oldLine: 41,
            newLine: 41,
          },
          {
            kind: "remove",
            content: "  scheduledFor: new Date(),",
            oldLine: 42,
          },
          {
            kind: "add",
            content: "  scheduledFor: startOfMinute(new Date()),",
            newLine: 42,
          },
          { kind: "context", content: "};", oldLine: 43, newLine: 43 },
          {
            kind: "context",
            content: "await withRunLock(run, () => execute(run));",
            oldLine: 44,
            newLine: 44,
          },
        ],
      },
      {
        id: "test",
        pr: 3150,
        path: "packages/junior/tests/integration/automation-schedule.test.ts",
        language: "ts",
        lines: [
          {
            kind: "add",
            content:
              'it("runs once when two deployments pick up the same tick", async () => {',
            newLine: 118,
          },
          {
            kind: "add",
            content: '  await tickOn("dpl_old", at("09:00"));',
            newLine: 119,
          },
          {
            kind: "add",
            content: '  await tickOn("dpl_new", at("09:00"));',
            newLine: 120,
          },
          {
            kind: "add",
            content: "  expect(await runsFor(automation)).toHaveLength(1);",
            newLine: 121,
          },
          { kind: "add", content: "});", newLine: 122 },
        ],
      },
    ],
    skipped: [{ reason: "generated", files: 1, lines: 14 }],
    checks: [
      {
        id: "ci",
        label: "CI on #3150",
        detail: "212 tests, 0 failed.",
        status: "passed",
      },
      {
        id: "regression",
        label: "New test fails on the base commit and passes on this PR",
        detail: "Base 0d4f7aa: fails. This PR 5be21c9: passes.",
        status: "passed",
      },
    ],
    sources: [
      {
        id: "sentry-dupes",
        kind: "sentry",
        text: "212 duplicate automation runs in 7 days. All started within 90 s of a deploy.",
        url: "https://sentry.sentry.io/issues/",
      },
      {
        id: "brief-report",
        kind: "brief_fact",
        text: "Reported in #proj-junior: the 9:00 standup digest posted twice on Tuesday.",
      },
      {
        id: "brief-lock-ttl",
        kind: "brief_decision",
        text: "Assumed: old locks expire after 10 minutes, so a deploy during the rollout can still double-run once.",
      },
    ],
    content: {
      title: "Scheduled automations run once, even during a deploy",
      intent:
        "A deploy made some scheduled automations run twice. This PR keys the run lock by schedule time, not by deployment.",
      diagram: {
        nodes: [
          { id: "scheduler", label: "Scheduler tick", column: 0, row: 0 },
          { id: "old", label: "Old deployment", column: 1, row: 0 },
          { id: "new", label: "New deployment", column: 1, row: 1 },
          { id: "lock", label: "Run lock", column: 2, row: 0 },
          { id: "run", label: "Automation run", column: 3, row: 0 },
        ],
        edges: [
          { id: "s-old", from: "scheduler", to: "old" },
          { id: "s-new", from: "scheduler", to: "new" },
          { id: "old-lock", from: "old", to: "lock", label: "take" },
          { id: "new-lock", from: "new", to: "lock", label: "take" },
          { id: "lock-run", from: "lock", to: "run", label: "once" },
        ],
      },
      chapters: [
        {
          id: "broken",
          type: "bug_fix",
          slot: "broken",
          caption: "After a deploy, some scheduled automations run twice.",
          body: "Sentry counts 212 duplicate runs in 7 days, all within 90 seconds of a deploy [1]. The person who asked for this PR saw the 9:00 standup digest post twice [2].",
          view: {
            show: [
              "scheduler",
              "old",
              "new",
              "lock",
              "run",
              "s-old",
              "s-new",
              "old-lock",
              "new-lock",
              "lock-run",
            ],
            highlight: ["run"],
            added: [],
            broken: [{ id: "lock-run", label: "twice" }],
          },
          evidence: [
            {
              kind: "source",
              sourceId: "sentry-dupes",
            },
            {
              kind: "source",
              sourceId: "brief-report",
            },
          ],
          decisions: [],
          asks: ["Which automations are affected?"],
        },
        {
          id: "cause",
          type: "bug_fix",
          slot: "cause",
          caption:
            "The lock key includes the deployment id. Two deployments take two different locks.",
          body: "During a rollout, the old and the new deployment both get the same tick. The lock key includes the deployment id [1], so each deployment takes its own lock and both run. A test that sends one tick to two deployments fails on the base commit [2].",
          view: {
            show: [
              "scheduler",
              "old",
              "new",
              "lock",
              "run",
              "s-old",
              "s-new",
              "old-lock",
              "new-lock",
              "lock-run",
            ],
            highlight: ["old-lock", "new-lock", "lock"],
            added: [],
            broken: [{ id: "new-lock", label: "own lock" }],
          },
          evidence: [
            {
              kind: "hunk",
              hunkId: "lock-key",
              lines: { start: 1, end: 2 },
              note: "During a rollout, old and new deployments both get the tick.",
            },
            { kind: "check", checkId: "regression" },
          ],
          decisions: [],
          asks: ["Why was the deployment id in the key?"],
        },
        {
          id: "fix",
          type: "bug_fix",
          slot: "fix",
          caption:
            "Key the lock by automation and scheduled time. This fixes the cause, not the symptom.",
          body: "The key is now the automation id plus the scheduled time [1]. Both deployments compute the same key, so only the first one gets the lock.",
          view: {
            show: [
              "scheduler",
              "old",
              "new",
              "lock",
              "run",
              "s-old",
              "s-new",
              "old-lock",
              "new-lock",
              "lock-run",
            ],
            highlight: ["lock", "lock-run"],
            added: [],
            broken: [],
          },
          evidence: [{ kind: "hunk", hunkId: "lock-key" }],
          decisions: [],
          asks: [],
        },
        {
          id: "side-effects",
          type: "bug_fix",
          slot: "side_effects",
          caption:
            "“Run now” uses the same lock. Two clicks in one minute now run once.",
          body: "It now rounds its time to the minute [1], so fast repeat clicks merge into one run. Locks taken before this PR keep the old key until they expire, so the first rollout can still double-run once [2].",
          evidence: [
            { kind: "hunk", hunkId: "run-now" },
            {
              kind: "source",
              sourceId: "brief-lock-ttl",
            },
          ],
          decisions: [
            {
              id: "run-now",
              question:
                "Two “Run now” clicks within a minute now run once. Is that OK?",
              origin: { kind: "behavior_change" },
              evidence: 0,
            },
            {
              id: "lock-ttl",
              question:
                "Junior assumed one more double run during the first rollout is fine. Is it?",
              origin: { kind: "assumed", sourceId: "brief-lock-ttl" },
              evidence: 1,
            },
          ],
          asks: ["What else calls withRunLock?"],
        },
        {
          id: "proof",
          type: "bug_fix",
          slot: "proof",
          caption:
            "A new test runs one tick on two deployments. It fails before the fix and passes after.",
          body: "Junior ran the new test [2] on the base commit, where it fails, and on this PR, where it passes [1]. The rest of CI passes too [3].",
          evidence: [
            { kind: "check", checkId: "regression" },
            { kind: "hunk", hunkId: "test" },
            { kind: "check", checkId: "ci" },
          ],
          decisions: [],
          asks: [],
        },
        {
          id: "after-ship",
          type: "ship_check",
          slot: "after_ship",
          caption:
            "Duplicate runs should drop to 0 within a day of the first deploy.",
          body: "Watch the Sentry issue from “What broke” [1]. After the first full deploy with this PR, it should get no new events.",
          evidence: [
            {
              kind: "source",
              sourceId: "sentry-dupes",
            },
          ],
          decisions: [],
          asks: [],
        },
      ],
      rootCause: "proven",
      splits: [],
      notCovered: [],
    },
    updates: [],
    meta: {
      modelId: "anthropic/claude-opus-5.5",
      promptVersion: 1,
      briefVersion: 2,
      costUsd: 0.31,
      createdAt: "2026-11-10T07:05:00.000Z",
    },
  });
}
