import assert from "node:assert/strict";
import test from "node:test";
import { assertQaAlias, assertQaDeployment } from "./slack-qa-alias.mjs";

const expected = {
  projectId: "prj_example",
  deploymentId: "dpl_test",
  sha: "a".repeat(40),
};
const preview = {
  id: expected.deploymentId,
  projectId: expected.projectId,
  name: "junior-example",
  readyState: "READY",
  target: null,
  meta: {
    githubCommitOrg: "getsentry",
    githubCommitRepo: "junior",
    githubCommitSha: expected.sha,
  },
};

test("accepts the requested ready example preview and its alias", () => {
  assertQaDeployment(preview, expected);
  assertQaDeployment({ ...preview, target: "preview" }, expected);
  assertQaAlias({ deploymentId: preview.id }, preview.id);
});

test("rejects deployments outside the selected preview", () => {
  for (const patch of [
    { id: "dpl_other" },
    { projectId: "prj_other" },
    { name: "junior-prod" },
    { readyState: "BUILDING" },
    { target: "production" },
    { target: undefined },
    { meta: { ...preview.meta, githubCommitOrg: "other" } },
    { meta: { ...preview.meta, githubCommitRepo: "other" } },
    { meta: { ...preview.meta, githubCommitSha: "b".repeat(40) } },
    { meta: undefined },
  ]) {
    assert.throws(() => assertQaDeployment({ ...preview, ...patch }, expected));
  }
});

test("rejects a moved, missing, or redirected alias", () => {
  for (const alias of [
    { deploymentId: "dpl_other" },
    { deploymentId: null },
    { deploymentId: preview.id, redirect: "other.example" },
  ]) {
    assert.throws(() => assertQaAlias(alias, preview.id), /Stop testing/);
  }
});
