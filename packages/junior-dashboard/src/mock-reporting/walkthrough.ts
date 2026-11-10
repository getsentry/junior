import type { WalkthroughDocument } from "@sentry/junior/api/schema";

const repo = "getsentry/junior";
const prUrl = (pr: number) => `https://github.com/${repo}/pull/${pr}`;

/** A fixed three-layer stack with one update, for the Walkthrough prototype. */
export function readMockWalkthrough(): WalkthroughDocument {
  return {
    schemaVersion: 1,
    versionId: "wt_v2",
    parentVersionId: "wt_v1",
    contentVersionId: "wt_v1",
    repository: repo,
    layers: [
      {
        pr: 3101,
        title: "Add refresh_tokens table",
        url: prUrl(3101),
        headSha: "a1f9c03",
        baseSha: "77c0e12",
        additions: 48,
        deletions: 12,
      },
      {
        pr: 3102,
        title: "Refresh the GitHub token on a 401",
        url: prUrl(3102),
        headSha: "c4d2e88",
        baseSha: "a1f9c03",
        additions: 132,
        deletions: 20,
      },
      {
        pr: 3103,
        title: "Move GitHub client files",
        url: prUrl(3103),
        headSha: "e90b417",
        baseSha: "c4d2e88",
        additions: 0,
        deletions: 0,
      },
    ],
    hunks: [
      {
        id: "3102-api-401",
        pr: 3102,
        path: "packages/junior-github/src/tool-support/github-api.ts",
        language: "ts",
        lines: [
          {
            kind: "context",
            content: "const res = await send(req);",
            oldLine: 88,
            newLine: 88,
          },
          {
            kind: "context",
            content: "if (res.status === 401) {",
            oldLine: 89,
            newLine: 89,
          },
          {
            kind: "remove",
            content: "  throw new GitHubAuthError(res);",
            oldLine: 90,
          },
          {
            kind: "add",
            content: "  await refreshToken(ctx.userId);",
            newLine: 90,
          },
          { kind: "add", content: "  return send(req); // once", newLine: 91 },
          { kind: "context", content: "}", oldLine: 91, newLine: 92 },
        ],
      },
      {
        id: "3102-api-retries",
        pr: 3102,
        path: "packages/junior-github/src/tool-support/github-api.ts",
        language: "ts",
        lines: [
          { kind: "remove", content: "const MAX_ATTEMPTS = 1;", oldLine: 14 },
          { kind: "add", content: "const MAX_ATTEMPTS = 3;", newLine: 14 },
        ],
      },
      {
        id: "3102-api-span",
        pr: 3102,
        path: "packages/junior-github/src/tool-support/github-api.ts",
        language: "ts",
        lines: [
          {
            kind: "add",
            content: 'span.setAttribute("github.token.refreshed", true);',
            newLine: 93,
          },
        ],
      },
      {
        id: "3101-sql",
        pr: 3101,
        path: "packages/junior-github/migrations/0042_refresh.sql",
        language: "sql",
        lines: [
          { kind: "add", content: "CREATE TABLE refresh_tokens (", newLine: 1 },
          { kind: "add", content: "  user_id text PRIMARY KEY,", newLine: 2 },
          {
            kind: "add",
            content: "  token_ciphertext bytea NOT NULL",
            newLine: 3,
          },
          { kind: "add", content: ");", newLine: 4 },
          { kind: "add", content: "DELETE FROM legacy_tokens;", newLine: 5 },
        ],
      },
      {
        id: "3101-sql-backup",
        pr: 3101,
        path: "packages/junior-github/migrations/0042_refresh.sql",
        language: "sql",
        lines: [
          { kind: "remove", content: "DELETE FROM legacy_tokens;", oldLine: 5 },
          {
            kind: "add",
            content:
              "ALTER TABLE legacy_tokens RENAME TO legacy_tokens_backup;",
            newLine: 5,
          },
        ],
      },
      {
        id: "3102-metric",
        pr: 3102,
        path: "packages/junior-github/src/tool-support/github-api.ts",
        language: "ts",
        lines: [
          {
            kind: "context",
            content: "} catch (error) {",
            oldLine: 101,
            newLine: 101,
          },
          {
            kind: "add",
            content: '  metrics.count("github.token.refresh_failed");',
            newLine: 102,
          },
          {
            kind: "context",
            content: "  throw error;",
            oldLine: 102,
            newLine: 103,
          },
        ],
      },
      {
        id: "3102-jitter",
        pr: 3102,
        path: "packages/junior-github/src/tool-support/github-api.ts",
        language: "ts",
        lines: [
          {
            kind: "remove",
            content: "await sleep(500 * attempt);",
            oldLine: 120,
          },
          {
            kind: "add",
            content: "await sleep(500 * attempt + jitter(250));",
            newLine: 120,
          },
        ],
      },
    ],
    skipped: [
      { reason: "moved", files: 21, lines: 1840 },
      { reason: "lockfile", files: 1, lines: 64 },
    ],
    checks: [
      { id: "ci-3102", label: "CI on #3102", status: "passed" },
      { id: "moves-3103", label: "#3103 only moves files", status: "passed" },
    ],
    sources: [
      {
        id: "sentry-401",
        kind: "sentry",
        text: "41 Tasks failed with a GitHub 401 in the last 14 days.",
        url: "https://sentry.sentry.io/issues/",
      },
      {
        id: "brief-intent",
        kind: "brief_fact",
        text: "Long Tasks fail after about 8 hours, when the GitHub user token expires.",
      },
      {
        id: "brief-legacy",
        kind: "brief_decision",
        text: "Assumed: nothing reads legacy_tokens since #2870.",
      },
    ],
    content: {
      title: "Long Tasks keep working when a GitHub token expires",
      intent:
        "GitHub user tokens expire after 8 hours. This stack refreshes the token on a 401 and tries the call once more.",
      diagram: {
        nodes: [
          { id: "task", label: "Task", column: 0, row: 0 },
          { id: "client", label: "GitHub client", column: 1, row: 0 },
          { id: "api", label: "GitHub API", column: 2, row: 0 },
          { id: "store", label: "Token store", column: 1, row: 1 },
          { id: "refresh", label: "Refresh", column: 2, row: 1 },
        ],
        edges: [
          { id: "t-c", from: "task", to: "client" },
          { id: "c-a", from: "client", to: "api", label: "call" },
          { id: "c-s", from: "client", to: "store", label: "token" },
          { id: "a-r", from: "api", to: "refresh", label: "401" },
          { id: "r-s", from: "refresh", to: "store", label: "save" },
        ],
      },
      chapters: [
        {
          id: "how-it-works",
          type: "feature",
          slot: "how_it_works",
          caption: "A Task calls GitHub with a stored user token.",
          view: {
            show: ["task", "client", "api", "store", "t-c", "c-a", "c-s"],
            highlight: ["t-c", "c-a", "c-s"],
            added: [],
            broken: [],
          },
          evidence: [],
          decisions: [],
          asks: ["Where is the token stored?"],
        },
        {
          id: "gap",
          type: "feature",
          slot: "gap",
          caption:
            "Tokens expire after 8 hours, and long Tasks fail with them.",
          view: {
            show: ["task", "client", "api", "store", "t-c", "c-a", "c-s"],
            highlight: ["api"],
            added: [],
            broken: [{ id: "c-a", label: "expired" }],
          },
          evidence: [
            {
              kind: "source",
              sourceId: "sentry-401",
              text: "41 failed Tasks in 2 weeks.",
            },
            {
              kind: "source",
              sourceId: "brief-intent",
              text: "Reported by the person who asked for this stack.",
            },
          ],
          decisions: [],
          asks: ["Why not use a longer-lived token?"],
        },
        {
          id: "change",
          type: "feature",
          slot: "change",
          caption: "On a 401, refresh the token, save it, and try once more.",
          view: {
            show: [
              "task",
              "client",
              "api",
              "store",
              "refresh",
              "t-c",
              "c-a",
              "c-s",
              "a-r",
              "r-s",
            ],
            highlight: ["refresh", "a-r", "r-s"],
            added: ["refresh", "a-r", "r-s"],
            broken: [],
          },
          evidence: [
            { kind: "hunk", hunkId: "3102-api-401" },
            {
              kind: "hunk",
              hunkId: "3102-api-retries",
              note: "Every GitHub call now retries, not only the 401 path.",
            },
          ],
          decisions: [
            {
              id: "retries",
              question:
                "It also raises retries for every call from 1 to 3. Nobody asked for that. Keep it?",
              origin: { kind: "not_asked" },
              evidence: 1,
            },
          ],
          asks: [
            "What if the refresh also returns a 401?",
            "Can two Tasks refresh at once?",
          ],
        },
        {
          id: "safe-to-run",
          type: "migration",
          slot: "safe_to_run",
          caption:
            "It deletes every row in legacy_tokens. That can't be undone.",
          evidence: [
            { kind: "hunk", hunkId: "3101-sql" },
            {
              kind: "source",
              sourceId: "brief-legacy",
              text: "Junior assumed nothing reads legacy_tokens.",
            },
          ],
          decisions: [
            {
              id: "delete",
              question:
                "Delete legacy_tokens? Junior assumed nothing reads it since #2870.",
              origin: { kind: "assumed", sourceId: "brief-legacy" },
              evidence: 0,
            },
          ],
          asks: ["What still references legacy_tokens?"],
        },
        {
          id: "how-well-know",
          type: "ship_check",
          slot: "how_well_know",
          caption: "Tests can't prove this works. Production will.",
          evidence: [
            {
              kind: "source",
              sourceId: "sentry-401",
              text: "Target: 0 Tasks failing with a 401.",
            },
            {
              kind: "hunk",
              hunkId: "3102-api-span",
              note: "Counts refreshes that work. Nothing counts refreshes that fail.",
            },
          ],
          decisions: [
            {
              id: "metric",
              question: "A failed refresh leaves no signal. Ask for a metric?",
              origin: { kind: "missing_signal" },
              evidence: 1,
            },
          ],
          asks: [],
        },
      ],
      splits: [],
      notCovered: [],
    },
    updates: [
      {
        versionId: "wt_v2",
        pushes: 3,
        createdAt: "2026-11-10T05:40:00.000Z",
        items: [
          {
            id: "backup",
            touches: "safe-to-run",
            answers: "delete",
            caption: "legacy_tokens is now renamed, not deleted.",
            evidence: [{ kind: "hunk", hunkId: "3101-sql-backup" }],
            decisions: [],
          },
          {
            id: "failed-metric",
            touches: "how-well-know",
            answers: "metric",
            caption: "Failed refreshes now have a metric.",
            evidence: [{ kind: "hunk", hunkId: "3102-metric" }],
            decisions: [],
          },
          {
            id: "jitter",
            touches: "change",
            caption: "Retries now wait up to 250 ms longer, at random.",
            evidence: [{ kind: "hunk", hunkId: "3102-jitter" }],
            decisions: [
              {
                id: "jitter",
                question: "Nobody asked for jitter. Keep it?",
                origin: { kind: "not_asked" },
                evidence: 0,
              },
            ],
          },
        ],
        addedChapters: [],
        notCovered: [],
      },
    ],
    meta: {
      modelId: "anthropic/claude-opus-5.5",
      promptVersion: 1,
      briefVersion: 4,
      costUsd: 0.81,
      createdAt: "2026-11-10T05:40:00.000Z",
    },
  };
}
