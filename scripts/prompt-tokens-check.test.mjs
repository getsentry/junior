import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findPromptTokensBase,
  promptTokensArtifactName,
  publishPromptTokensStatus,
} from "./prompt-tokens-check.mjs";

const repo = { owner: "getsentry", repo: "junior" };

function pullRequestContext() {
  return {
    repo,
    sha: "merge-sha",
    runId: 42,
    serverUrl: "https://github.com",
    payload: {
      pull_request: { base: { sha: "base-sha" }, head: { sha: "head-sha" } },
    },
  };
}

function fakeCore() {
  const outputs = {};
  const summaries = [];
  return {
    outputs,
    summaries,
    info: () => undefined,
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    summary: {
      addRaw(text) {
        summaries.push(text);
        return this;
      },
      write: async () => undefined,
    },
  };
}

function fakeGithub(artifacts = []) {
  const calls = [];
  return {
    calls,
    rest: {
      actions: {
        listArtifactsForRepo: async (params) => {
          calls.push(["listArtifactsForRepo", params]);
          return { data: { artifacts } };
        },
      },
      repos: {
        createCommitStatus: async (params) => {
          calls.push(["createCommitStatus", params]);
        },
      },
    },
  };
}

function writeStats(dir, name, toolTokens) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      model: "anthropic/claude-test",
      sections: [{ name: "evidence", group: "rules", chars: 25, tokens: 10 }],
      tools: [{ name: "bash", chars: 25, tokens: toolTokens }],
      skills: [],
      turnContext: { name: "turn context", chars: 5, tokens: 2 },
    }),
  );
  return file;
}

test("finds the run that uploaded the base commit's stats", async () => {
  const github = fakeGithub([
    { expired: true, workflow_run: { id: 1 } },
    { expired: false, workflow_run: { id: 7 } },
  ]);
  const core = fakeCore();
  await findPromptTokensBase({ github, context: pullRequestContext(), core });

  assert.deepEqual(github.calls, [
    [
      "listArtifactsForRepo",
      { ...repo, name: promptTokensArtifactName("base-sha") },
    ],
  ]);
  assert.deepEqual(core.outputs, { "run-id": "7", sha: "base-sha" });
});

test("uses the previous commit of a push as the base", async () => {
  const github = fakeGithub();
  const core = fakeCore();
  await findPromptTokensBase({
    github,
    context: { repo, payload: { before: "before-sha" } },
    core,
  });

  assert.equal(github.calls[0][1].name, "prompt-tokens-before-sha");
  assert.deepEqual(core.outputs, {});
});

test("publishes the status on the pull request head with the change", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-tokens-check-"));
  const github = fakeGithub();
  const core = fakeCore();
  await publishPromptTokensStatus({
    github,
    context: pullRequestContext(),
    core,
    statsPath: writeStats(dir, "current.json", 30),
    basePath: writeStats(dir, "base.json", 20),
    baseSha: "base-sha-full",
  });

  assert.deepEqual(github.calls, [
    [
      "createCommitStatus",
      {
        ...repo,
        sha: "head-sha",
        state: "success",
        context: "prompt tokens",
        description: "40 tokens (+10 vs base-sh)",
        target_url: "https://github.com/getsentry/junior/actions/runs/42",
      },
    ],
  ]);
  assert.equal(core.summaries.length, 1);
  assert.match(core.summaries[0], /^\+10 tokens .* vs `base-sh`\.$/m);
});

test("publishes the status of a push without base stats", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-tokens-check-"));
  const github = fakeGithub();
  const core = fakeCore();
  await publishPromptTokensStatus({
    github,
    context: { repo, sha: "push-sha", runId: 1, serverUrl: "", payload: {} },
    core,
    statsPath: writeStats(dir, "current.json", 30),
    basePath: "",
    baseSha: "",
  });

  const [[, status]] = github.calls;
  assert.equal(status.sha, "push-sha");
  assert.equal(status.description, "40 tokens");
  assert.doesNotMatch(core.summaries[0], /vs/);
});

test("rejects stats that do not validate before it writes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-tokens-check-"));
  const statsPath = path.join(dir, "bad.json");
  fs.writeFileSync(statsPath, JSON.stringify({ version: 1, model: "x" }));
  const github = fakeGithub();
  await assert.rejects(
    publishPromptTokensStatus({
      github,
      context: pullRequestContext(),
      core: fakeCore(),
      statsPath,
      basePath: "",
      baseSha: "",
    }),
    /version 1/,
  );
  assert.deepEqual(github.calls, []);
});
