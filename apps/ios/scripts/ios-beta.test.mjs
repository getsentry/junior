import assert from "node:assert/strict";
import test from "node:test";
import {
  betaStatusLine,
  dispatchBeta,
  reportBeta,
  withBetaStatus,
} from "./ios-beta.mjs";

const repo = { owner: "getsentry", repo: "junior" };

function fakeGithub({
  body = "Fixes a bug.",
  removeLabelStatus,
  dispatchStatus,
  dispatchMessage = "dispatch failed",
} = {}) {
  const calls = [];
  return {
    calls,
    rest: {
      issues: {
        removeLabel: async (params) => {
          calls.push(["removeLabel", params]);
          if (removeLabelStatus)
            throw Object.assign(new Error("failed"), {
              status: removeLabelStatus,
            });
        },
      },
      actions: {
        createWorkflowDispatch: async (params) => {
          calls.push(["createWorkflowDispatch", params]);
          if (dispatchStatus)
            throw Object.assign(new Error(dispatchMessage), {
              status: dispatchStatus,
            });
        },
      },
      pulls: {
        get: async (params) => {
          calls.push(["get", params]);
          return { data: { body } };
        },
        update: async (params) => {
          calls.push(["update", params]);
        },
      },
    },
  };
}

const core = { info: () => undefined };

function labelContext() {
  return {
    repo,
    serverUrl: "https://github.com",
    payload: { pull_request: { number: 7, head: { ref: "ios/feature" } } },
  };
}

function runContext() {
  return {
    repo,
    serverUrl: "https://github.com",
    runId: 99,
    sha: "abcdef1234567",
  };
}

test("withBetaStatus appends the block once and then replaces it", () => {
  const first = withBetaStatus("Fixes a bug.", "one");
  assert.equal(
    first,
    "Fixes a bug.\n\n<!-- ios-beta:start -->\none\n<!-- ios-beta:end -->",
  );
  const second = withBetaStatus(`${first}\n\nfooter`, "two");
  assert.equal(
    second,
    "Fixes a bug.\n\n<!-- ios-beta:start -->\ntwo\n<!-- ios-beta:end -->\n\nfooter",
  );
});

test("withBetaStatus handles an empty body", () => {
  assert.equal(
    withBetaStatus(null, "one"),
    "<!-- ios-beta:start -->\none\n<!-- ios-beta:end -->",
  );
});

test("dispatchBeta removes the label, dispatches on the branch, and shows queued", async () => {
  const github = fakeGithub();
  await dispatchBeta({ github, context: labelContext(), core });
  assert.deepEqual(github.calls[0], [
    "removeLabel",
    { ...repo, issue_number: 7, name: "trigger-ios-beta" },
  ]);
  assert.deepEqual(github.calls[1], [
    "createWorkflowDispatch",
    {
      ...repo,
      workflow_id: "ios-beta.yml",
      ref: "ios/feature",
      inputs: { pull_request: "7" },
    },
  ]);
  const [name, update] = github.calls[3];
  assert.equal(name, "update");
  assert.match(
    update.body,
    /\*\*iOS beta:\*\* queued · \[runs\]\(https:\/\/github\.com\/getsentry\/junior\/actions\/workflows\/ios-beta\.yml\)/,
  );
});

test("dispatchBeta still dispatches when the label is already gone", async () => {
  const github = fakeGithub({ removeLabelStatus: 404 });
  await dispatchBeta({ github, context: labelContext(), core });
  assert.equal(github.calls[1][0], "createWorkflowDispatch");
});

test("dispatchBeta stops on other label errors", async () => {
  const github = fakeGithub({ removeLabelStatus: 403 });
  await assert.rejects(
    dispatchBeta({ github, context: labelContext(), core }),
    /failed/,
  );
  assert.equal(github.calls.length, 1);
});

test("dispatchBeta says to merge main when the branch's workflow is older", async () => {
  const github = fakeGithub({
    dispatchStatus: 422,
    dispatchMessage: 'Unexpected inputs provided: ["pull_request"]',
  });
  await assert.rejects(
    dispatchBeta({ github, context: labelContext(), core }),
    /Unexpected inputs/,
  );
  const [name, update] = github.calls.at(-1);
  assert.equal(name, "update");
  assert.match(
    update.body,
    /not started\. .*merge `main`, then add the label again/,
  );
});

test("dispatchBeta writes no status on other dispatch errors", async () => {
  const github = fakeGithub({ dispatchStatus: 422 });
  await assert.rejects(
    dispatchBeta({ github, context: labelContext(), core }),
    /dispatch failed/,
  );
  assert.equal(github.calls.at(-1)[0], "createWorkflowDispatch");
});

test("reportBeta writes the result with the build and run link", async () => {
  const github = fakeGithub();
  await reportBeta({
    github,
    context: runContext(),
    pullRequest: "7",
    state: "success",
    build: "42",
  });
  const [, update] = github.calls[1];
  assert.equal(update.pull_number, 7);
  assert.match(
    update.body,
    /build 42 of `abcdef1` uploaded to TestFlight · \[run\]\(https:\/\/github\.com\/getsentry\/junior\/actions\/runs\/99\)/,
  );
});

test("reportBeta rejects a pull request that is not a number", async () => {
  const github = fakeGithub();
  await assert.rejects(
    reportBeta({
      github,
      context: runContext(),
      pullRequest: "7; x",
      state: "building",
    }),
  );
  assert.equal(github.calls.length, 0);
});

test("betaStatusLine treats any other result as failed", () => {
  assert.match(
    betaStatusLine({ state: "failure", sha: "abcdef1234", runUrl: "u" }),
    /failed for `abcdef1`/,
  );
  assert.match(
    betaStatusLine({ state: "skipped", sha: "abcdef1234", runUrl: "u" }),
    /failed/,
  );
});
