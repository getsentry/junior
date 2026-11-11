import { describe, expect, it } from "vitest";
import { readWalkthroughDiff } from "@/chat/walkthroughs/diff";
import {
  walkthroughDocumentSchema,
  type WalkthroughDocument,
} from "@/chat/walkthroughs/schema";
import {
  compareWalkthroughStack,
  walkthroughFileHashes,
} from "@/chat/walkthroughs/update";

const sha = (digit: string) => digit.repeat(40);

function diff(pr: number, files: Record<string, string>) {
  return readWalkthroughDiff(
    pr,
    Object.entries(files).map(([path, patch]) => ({
      path,
      status: "modified" as const,
      patch,
    })),
  ).files;
}

const RETRY = "@@ -1,2 +1,2 @@\n context\n-delay = 2\n+delay = 3";
const LOCK = "@@ -4,1 +4,2 @@\n lock()\n+release()";

function layer(pr: number, headSha: string) {
  return {
    number: pr,
    title: `PR ${pr}`,
    body: "",
    url: `https://github.com/getsentry/junior/pull/${pr}`,
    baseSha: sha("a"),
    headSha,
    additions: 1,
    deletions: 1,
  };
}

function previous(): WalkthroughDocument {
  const files = [
    ...diff(1, { "src/lock.ts": LOCK }),
    ...diff(2, { "src/retry.ts": RETRY }),
  ];
  const chapter = (id: string, pr: number, path: string) => ({
    id,
    type: "feature",
    slot: "change",
    caption: `Chapter ${id}.`,
    body: "It changes [1].",
    evidence: [{ kind: "code", pr, path, start: 1, end: 1 }],
  });
  return walkthroughDocumentSchema.parse({
    schemaVersion: 2,
    versionId: "v1",
    contentVersionId: "v1",
    repository: "getsentry/junior",
    layers: [layer(1, sha("b")), layer(2, sha("c"))].map(
      ({ number, body: _body, ...rest }) => ({ pr: number, ...rest }),
    ),
    excerpts: [],
    files: walkthroughFileHashes(files),
    skipped: [],
    checks: [],
    messages: [],
    content: {
      title: "Locks and retries",
      intent: "This stack adds a lock and changes retries.",
      diagrams: [
        {
          pr: 1,
          nodes: [{ id: "lock", label: "Lock" }],
          edges: [],
        },
      ],
      chapters: [
        chapter("lock", 1, "src/lock.ts"),
        chapter("retry", 2, "src/retry.ts"),
      ],
    },
    updates: [],
    meta: {
      modelId: "test-model",
      promptVersion: 2,
      createdAt: new Date().toISOString(),
    },
  });
}

describe("compareWalkthroughStack", () => {
  it("ignores a rebase that only moves context lines", () => {
    const rebased = diff(2, {
      "src/retry.ts": "@@ -9,2 +9,2 @@\n other context\n-delay = 2\n+delay = 3",
    });
    const changes = compareWalkthroughStack(
      previous(),
      [layer(1, sha("b")), layer(2, sha("d"))],
      [...diff(1, { "src/lock.ts": LOCK }), ...rebased],
    );
    expect(changes).toMatchObject({
      changedChapters: [],
      movedLayers: [2],
      newLayers: [],
      leftLayers: [],
    });
    expect([...changes.changedFiles]).toEqual([]);
  });

  it("marks chapters whose cited file changed and layers that left", () => {
    const changes = compareWalkthroughStack(
      previous(),
      [layer(2, sha("d")), layer(3, sha("e"))],
      [
        ...diff(2, { "src/retry.ts": RETRY.replace("3", "5") }),
        ...diff(3, { "src/new.ts": "@@ -0,0 +1 @@\n+new()" }),
      ],
    );
    expect(changes).toMatchObject({
      changedChapters: ["retry"],
      movedLayers: [2],
      newLayers: [3],
      leftLayers: [{ pr: 1, title: "PR 1" }],
    });
    expect([...changes.changedFiles].sort()).toEqual([
      "2:src/retry.ts",
      "3:src/new.ts",
    ]);
  });
});
