// One-off: convert the format v2 mock fixtures to format v3 (story-first).
// Chapters get a label instead of a type and slot, `types` moves to the
// Walkthrough, and not_covered becomes also_changed, grouped by reason.
// The stack fixture is rewritten by hand as one story: its chapters reuse
// the old evidence (so every excerpt id still resolves) and keep the old
// chapter and decision ids where a chapter survives.
// Usage: node convert-v3.mjs PR3071_JSON STACK_JSON (rewrites in place),
// then run prettier on both files.
import { readFileSync, writeFileSync } from "node:fs";

const [single, stack] = process.argv.slice(2);

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function save(path, data) {
  // Compact, so prettier lays it out the way the fixtures already are.
  writeFileSync(path, JSON.stringify(data));
}

function chapterOf(content) {
  return (id) => {
    const chapter = content.chapters.find((c) => c.id === id);
    if (!chapter) throw new Error(`No chapter ${id}`);
    return chapter;
  };
}

/** Evidence item `n` (1-based) of an old chapter. */
function evidenceOf(chapter) {
  return (id, n) => {
    const item = chapter(id).evidence[n - 1];
    if (!item) throw new Error(`No evidence ${id}[${n}]`);
    return item;
  };
}

/** A decision of an old chapter, pointed at a new evidence index (0-based). */
function decisionOf(chapter) {
  return (id, decisionId, evidence) => {
    const decision = chapter(id).decisions.find((d) => d.id === decisionId);
    if (!decision) throw new Error(`No decision ${decisionId}`);
    return { ...decision, evidence };
  };
}

function finish(document, content) {
  document.schemaVersion = 3;
  delete content.splits;
  delete content.not_covered;
  for (const chapter of content.chapters) {
    const citations = new Set(
      [...chapter.body.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
    );
    for (let n = 1; n <= chapter.evidence.length; n++) {
      if (!citations.has(n)) throw new Error(`${chapter.id} skips [${n}]`);
    }
    if (chapter.body.length > 600) throw new Error(`${chapter.id} body`);
    if (chapter.evidence.length > 6) throw new Error(`${chapter.id} evidence`);
  }
}

function convertSingle(path) {
  const data = load(path);
  const content = data.document.content;
  const labels = {
    "one-helper": "The shared filter",
    "token-matches": "Proof it matches",
    "board-and-left-out": "What stays different",
  };
  content.types = ["refactor"];
  content.chapters = content.chapters.map(
    ({ type: _type, slot: _slot, ...chapter }) => ({
      ...chapter,
      label: labels[chapter.id],
    }),
  );
  const files = (paths) =>
    paths.map((p) => ({ pr: 3071, path: `packages/junior/${p}` }));
  content.also_changed = [
    {
      reason: "Only import the new helper",
      files: files([
        "src/api/board/read.ts",
        "src/api/conversations/list.ts",
        "src/chat/agent-invocations/search-top-level.ts",
        "src/chat/briefs/search.ts",
      ]),
    },
    {
      reason: "Imports a schema for the token check",
      files: files(["tests/integration/api/conversations/fork.test.ts"]),
    },
  ];
  finish(data.document, content);
  save(path, data);
}

function convertStack(path) {
  const data = load(path);
  const content = data.document.content;
  const chapter = chapterOf(content);
  const ev = evidenceOf(chapter);
  const decision = decisionOf(chapter);
  const asks = (...ids) =>
    ids.flatMap((id) => chapter(id).asks).slice(0, 3);

  content.types = ["feature", "migration"];
  content.chapters = [
    {
      id: "gap",
      label: "The problem",
      caption:
        "A summary of an agent-written stack can quote code that does not exist.",
      body: "A reviewer of an agent-written stack gets the raw diff, which is long, or a model summary, which can invent code. This stack adds Walkthroughs: one guided story whose every claim cites a PR, a file and line range, or a message, and never copies text [1]. Junior re-reads each citation from the provider before it stores the story, so what the reader sees is what the code says.",
      view: chapter("gap").view,
      evidence: [ev("gap", 1)],
      decisions: [],
      asks: asks("gap"),
    },
    {
      id: "start-flow",
      label: "Starting a Walkthrough",
      caption:
        "A click claims one version, and only the winning click queues a hidden generation Turn.",
      body: "A reviewer clicks Walkthrough on a PR. The API reads the open stack around it and claims a version for that exact set of commits [1]. Only the click that wins the claim starts a hidden web Conversation whose Turn writes the story; if queueing fails, the version fails [2]. A second click on the same commits joins that version instead of starting another [3], and a version still generating after 30 minutes fails on the next click [4].",
      view: chapter("start-flow").view,
      evidence: [
        ev("start-flow", 1),
        ev("start-flow", 2),
        ev("versions-table", 3),
        ev("start-flow", 3),
      ],
      decisions: [decision("start-flow", "runs-as-clicker", 1)],
      asks: asks("start-flow"),
    },
    {
      id: "hooks",
      label: "Reading the stack",
      caption:
        "Plugins read the stack, diffs, and files, so core never calls GitHub itself.",
      body: "Core must not call provider APIs, so plugins get a read-only codeChanges hook group that reads a stack, a diff, or a file [1]. Core picks the plugin by provider and runs it as a system Actor that never prompts anyone [2]. GitHub finds the stack through its Stacks API, or walks base branches until the trunk, a fork, or 10 levels [3][4]. Diffs compare exact base and head commits, so a later push cannot change what the story describes [5].",
      view: chapter("hooks").view,
      evidence: [
        ev("hooks", 2),
        ev("hooks", 3),
        ev("github-reads", 1),
        ev("github-reads", 2),
        ev("github-reads", 3),
      ],
      decisions: [decision("github-reads", "fork-prs", 3)],
      asks: asks("hooks", "github-reads"),
    },
    {
      id: "submit-tool",
      label: "Checking every citation",
      caption:
        "submitWalkthrough re-reads every cited fact and rejects the story until each citation resolves.",
      body: "The model reads the diffs in its sandbox, led by a skill that only generation Turns get [1]. Its submit tool re-reads diffs and files through the plugin hooks, and copies cited messages only after an access check [2][3]. A pure validator returns every problem, such as a citation that does not resolve or a changed hunk that nothing cites, and the model fixes them and submits again [4]. Code excerpts come from the provider diff, never from the model [5], and mechanical files are only counted [6].",
      view: chapter("submit-tool").view,
      evidence: [
        ev("submit-tool", 1),
        ev("submit-tool", 2),
        ev("submit-tool", 3),
        ev("format", 1),
        ev("format", 3),
        ev("format", 2),
      ],
      decisions: [decision("submit-tool", "sandbox-github", 0)],
      asks: asks("submit-tool", "format"),
    },
    {
      id: "isolation",
      label: "What a generation Turn may do",
      caption:
        "Only a generation Turn gets the submit tool, with its own caps and no way to reach people.",
      body: "A new generation behavior is the only one with submitWalkthrough on, and it turns off agents, the review desk, subscriptions, user customization, and noReply [1][2]. The tool exists only when that behavior and the run's generation field are both set, and only the Turn worker sets the field [3][4]. The same behavior caps a generation at 80 tool calls and $5, and other Turns keep their limits [5][6].",
      evidence: [
        ev("isolation", 1),
        ev("isolation", 2),
        ev("isolation", 3),
        ev("isolation", 4),
        ev("limits", 2),
        ev("limits", 4),
      ],
      decisions: [decision("limits", "limit-values", 4)],
      asks: asks("isolation", "limits"),
    },
    {
      ...chapter("finish"),
      label: "When a generation fails",
      type: undefined,
      slot: undefined,
    },
    {
      id: "versions-table",
      label: "Storage and migration",
      caption:
        "Each version is a row, one live version per snapshot, and lists hide generation Conversations.",
      body: "Migration 0100 adds junior_walkthrough_versions with a partial unique index: one live version per provider, repository, and snapshot [1][2]. It only adds a table and indexes. Its one effect on existing reads is a NOT EXISTS probe on generation_conversation_id in every list and search, so generation Conversations stay out of lists [3][4]. To roll back, revert the code first, because the filter needs the table.",
      view: chapter("versions-table").view,
      evidence: [
        ev("versions-table", 1),
        ev("versions-table", 2),
        ev("safe-to-run", 1),
        ev("safe-to-run", 2),
      ],
      decisions: [
        decision("versions-table", "no-fk", 1),
        decision("safe-to-run", "list-probe-cost", 2),
      ],
      asks: asks("versions-table", "safe-to-run"),
    },
    {
      ...chapter("after-ship"),
      label: "What to watch after it ships",
      type: undefined,
      slot: undefined,
    },
  ].map((c) => JSON.parse(JSON.stringify(c)));

  const files = (pr, paths) =>
    paths.map((p) => ({ pr, path: `packages/${p}` }));
  content.also_changed = [
    {
      reason: "Tests of the rules above",
      files: [
        ...files(3087, [
          "junior/tests/unit/walkthroughs/diff.test.ts",
          "junior/tests/unit/walkthroughs/validate.test.ts",
        ]),
        ...files(3088, ["junior-github/tests/code-changes.test.ts"]),
        ...files(3124, [
          "junior/tests/integration/walkthrough-versions.test.ts",
          "junior/tests/unit/chat/kind-behavior.test.ts",
          "junior/tests/unit/walkthroughs/validate.test.ts",
        ]),
        ...files(3133, ["junior/tests/unit/chat/kind-behavior.test.ts"]),
      ],
    },
    {
      reason: "Wiring, types, and re-exports",
      files: [
        ...files(3088, [
          "junior-github/src/plugin.ts",
          "junior-plugin-api/src/hooks.ts",
        ]),
        ...files(3090, ["junior/src/db/schema.ts"]),
        ...files(3124, [
          "junior/src/chat/agent/tools.ts",
          "junior/src/chat/agent/types.ts",
          "junior/src/chat/tools/types.ts",
        ]),
        ...files(3133, [
          "junior/src/api.ts",
          "junior/src/chat/experimental.ts",
          "junior/src/chat/plugins/code-change-hooks.ts",
        ]),
      ],
    },
    {
      reason: "A snake_case rename of two fields",
      files: files(3124, [
        "junior/src/chat/walkthroughs/schema.ts",
        "junior/src/chat/walkthroughs/validate.ts",
      ]),
    },
    {
      reason: "Request schemas and the experiment flag docs",
      files: files(3133, [
        "docs/src/content/docs/reference/config-and-env.md",
        "junior/src/api/schema/walkthrough.ts",
      ]),
    },
    {
      reason: "Generated migration journal",
      files: files(3090, ["junior/migrations/meta/_journal.json"]),
    },
  ];
  finish(data.document, content);
  save(path, data);
}

convertSingle(single);
convertStack(stack);
