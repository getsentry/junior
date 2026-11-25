import type { PluginTaskStartInput } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { juniorGitHubPullRequestRequesters } from "../src/db/schema";
import {
  GITHUB_PULL_REQUEST_REQUESTER_BACKFILL_TASK,
  startGitHubPullRequestRequesterBackfill,
} from "../src/pull-request-requesters/backfill";
import { recordJuniorPullRequest } from "./code-index";
import { createGitHubFixture, type GitHubFixture } from "./github-db";
import { createPluginHarness, memoryState } from "./plugin-harness";

describe("one-off backfill of pull request requesters", () => {
  let fixture: GitHubFixture;
  const updatedAt = new Date("2026-11-20T12:00:00.000Z");

  beforeEach(async () => {
    fixture = await createGitHubFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  async function saveRequester(number: number, identityId: string) {
    await fixture.db().insert(juniorGitHubPullRequestRequesters).values({
      createdAt: updatedAt,
      identityId,
      number,
      repositoryFullName: "getsentry/junior",
      updatedAt,
    });
  }

  it("credits the saved requesters of open, merged, and closed pull requests once", async () => {
    await recordJuniorPullRequest(fixture, { number: 946, updatedAt });
    await recordJuniorPullRequest(fixture, {
      finishedAt: updatedAt,
      number: 947,
      state: "merged",
      updatedAt,
    });
    await recordJuniorPullRequest(fixture, {
      finishedAt: updatedAt,
      number: 948,
      state: "closed_unmerged",
      updatedAt,
    });
    await saveRequester(946, "identity-jane");
    await saveRequester(946, "identity-sam");
    await saveRequester(947, "identity-jane");
    await saveRequester(948, "identity-sam");
    // The code index does not have it yet. Its lifecycle webhook credits it.
    await saveRequester(949, "identity-jane");

    const h = createPluginHarness(fixture);
    h.startedTasks.push({
      key: "pull-request-requester-backfill:start",
      name: GITHUB_PULL_REQUEST_REQUESTER_BACKFILL_TASK,
      payload: {},
    });
    await h.runStartedTasks();
    // It reads only the stored rows.
    expect(h.heartbeatLogs).toEqual([]);
    expect(
      ["9460", "9470", "9480"].map((id) => fixture.codeIndex.requesters(id)),
    ).toEqual([
      ["identity-jane", "identity-sam"],
      ["identity-jane"],
      ["identity-sam"],
    ]);

    // A run after the last page changes nothing.
    await saveRequester(947, "identity-sam");
    h.startedTasks.push({
      key: "pull-request-requester-backfill:again",
      name: GITHUB_PULL_REQUEST_REQUESTER_BACKFILL_TASK,
      payload: {},
    });
    await h.runStartedTasks();
    expect(fixture.codeIndex.requesters("9470")).toEqual(["identity-jane"]);
  });

  it("starts pages until the last one is done", async () => {
    const state = memoryState();
    const started: PluginTaskStartInput[] = [];
    const tasks = {
      async start(input: PluginTaskStartInput) {
        started.push(input);
      },
    };
    await startGitHubPullRequestRequesterBackfill({ state, tasks });
    await state.set("pull-request-requester-backfill:cursor", {
      number: 946,
      repositoryFullName: "getsentry/junior",
    });
    await startGitHubPullRequestRequesterBackfill({ state, tasks });
    await state.set("pull-request-requester-backfill:done", true);
    await startGitHubPullRequestRequesterBackfill({ state, tasks });
    expect(started.map((input) => input.key)).toEqual([
      "pull-request-requester-backfill:start",
      "pull-request-requester-backfill:getsentry/junior#946",
    ]);
  });
});
