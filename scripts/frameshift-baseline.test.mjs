import assert from "node:assert/strict";
import test from "node:test";
import {
  findFrameshiftBaseline,
  frameshiftBaselineArtifactName,
} from "./frameshift-baseline.mjs";

const repo = { owner: "getsentry", repo: "junior" };

function fakeCore() {
  const outputs = {};
  return {
    outputs,
    info: () => undefined,
    setOutput: (name, value) => {
      outputs[name] = value;
    },
  };
}

function fakeGithub({ parents, artifacts }) {
  const calls = [];
  return {
    calls,
    rest: {
      git: {
        getCommit: async (params) => {
          calls.push(["getCommit", params]);
          return { data: { parents } };
        },
      },
      actions: {
        listArtifactsForRepo: async (params) => {
          calls.push(["listArtifactsForRepo", params]);
          return { data: { artifacts } };
        },
      },
    },
  };
}

const context = {
  repo,
  sha: "merge-sha",
  payload: { pull_request: { base: { sha: "stale-base-sha" } } },
};

test("uses the merge commit's first parent, not the pull request base", async () => {
  const github = fakeGithub({
    parents: [{ sha: "main-sha" }, { sha: "head-sha" }],
    artifacts: [{ expired: false }],
  });
  const core = fakeCore();

  await findFrameshiftBaseline({ github, context, core });

  assert.deepEqual(github.calls, [
    ["getCommit", { ...repo, commit_sha: "merge-sha" }],
    [
      "listArtifactsForRepo",
      { ...repo, name: frameshiftBaselineArtifactName("main-sha") },
    ],
  ]);
  assert.deepEqual(core.outputs, { sha: "main-sha", found: "true" });
});

test("reports no baseline when its screenshots are missing or expired", async () => {
  const github = fakeGithub({
    parents: [{ sha: "main-sha" }, { sha: "head-sha" }],
    artifacts: [{ expired: true }],
  });
  const core = fakeCore();

  await findFrameshiftBaseline({ github, context, core });

  assert.deepEqual(core.outputs, { sha: "main-sha", found: "false" });
});

test("fails on a commit with no parent", async () => {
  const github = fakeGithub({ parents: [], artifacts: [] });

  await assert.rejects(
    findFrameshiftBaseline({ github, context, core: fakeCore() }),
    /has no parent/,
  );
});
