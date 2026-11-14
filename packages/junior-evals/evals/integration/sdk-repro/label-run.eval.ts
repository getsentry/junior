import { describe, expect } from "vitest";
import { readGitHubSdkReproWrites } from "@junior-evals/fixture/github";
import { githubWebhook } from "@junior-evals/fixture/inputs";
import {
  insertEventAutomation,
  slackChannel,
  type SlackChannel,
} from "@junior-evals/fixture/insert";
import { toolCallsOf } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// The fake GitHub serves this repository's issues #10 to #13
// (`packages/junior-testing/src/http/github-sdk-repro.ts`).
const repo = "getsentry/sdk-repro-test-python";
const maintainer = { id: 20001, login: "sdk-maintainer" };

/** Store the label automation of production, which runs the skill. */
async function insertLabelAutomation(destination: SlackChannel) {
  await insertEventAutomation({
    destination,
    task: {
      kind: "skill",
      skill: "sdk-repro",
      context: "The issue and the sender come from the event.",
    },
    trigger: {
      events: ["issue.updated"],
      identifier: repo,
      label: `GitHub repository ${repo}`,
      match: { change: "labeled", label: "junior: repro" },
      namespace: "github",
      resourceType: "repository",
    },
  });
}

function labeled(issue: number, sender: { id: number; login: string }) {
  return githubWebhook("issues", {
    action: "labeled",
    issue: {
      body: "`sentry_sdk.set_tag` drops tags with an empty value.",
      number: issue,
      title: "set_tag drops tags with an empty value",
      updated_at: "2026-10-12T15:59:00Z",
    },
    label: { name: "Junior: repro" },
    repository: { full_name: repo },
    sender,
  });
}

/** The one issue comment of a stop, which names `found` when set. */
const stopComment = (issue: number, found = "") => ({
  method: "POST",
  path: `/repos/${repo}/issues/${issue}/comments`,
  body: {
    body: expect.stringMatching(
      new RegExp(`^<!-- sdk-repro -->\\n[\\s\\S]*${found}`),
    ),
  },
});

describe("sdk-repro label runs", () => {
  // The evals have no Workspace, so the run passes every guard and stops at
  // the Workspace step, the last step before the repro.
  test("when an allowed sender labels an issue with no existing work, pass the guards", async ({
    run,
  }) => {
    const destination = slackChannel();
    await insertLabelAutomation(destination);

    const delivery = await run(labeled(10, maintainer));

    expect(delivery.replies).toEqual([
      expect.objectContaining({
        channelId: destination.channelId,
        text: expect.stringContaining("stopped: no workspace"),
      }),
    ]);
    const github = await readGitHubSdkReproWrites();
    expect(github).toHaveLength(2);
    expect(github).toEqual(
      expect.arrayContaining([
        {
          method: "POST",
          path: `/repos/${repo}/issues/10/reactions`,
          body: { content: "eyes" },
        },
        stopComment(10),
      ]),
    );
  });

  test.for([
    {
      // Only `linear-code[bot]` may start a run.
      stop: "requester not allowed",
      issue: 11,
      sender: { id: 29139614, login: "renovate[bot]" },
      replies: 1,
      writes: [],
      mayReact: false,
    },
    {
      // Open PR #14 says `resolves: #12`.
      stop: "existing work",
      issue: 12,
      sender: maintainer,
      replies: 1,
      writes: [stopComment(12, String.raw`(pull/14|#14\b)`)],
      mayReact: true,
    },
    {
      // A progress comment from 30 minutes ago. The other run reports.
      stop: "run in progress",
      issue: 13,
      sender: maintainer,
      replies: 0,
      writes: [],
      mayReact: true,
    },
  ])(
    "when the issue has $stop, stop before the Workspace",
    async ({ issue, mayReact, replies, sender, stop, writes }, { run }) => {
      const destination = slackChannel();
      await insertLabelAutomation(destination);

      const delivery = await run(labeled(issue, sender));

      expect(delivery.replies).toEqual(
        Array.from({ length: replies }, () =>
          expect.objectContaining({
            channelId: destination.channelId,
            text: expect.stringContaining(`stopped: ${stop}`),
          }),
        ),
      );
      expect(toolCallsOf("switchWorkspace", delivery)).toEqual([]);
      expect(toolCallsOf("github_createPullRequest", delivery)).toEqual([]);

      // Every stop after the `eyes` reaction leaves one stop comment, except
      // a stop for a run in progress. A stop before it writes nothing.
      const github = await readGitHubSdkReproWrites();
      const reaction = (write: { path: string }) =>
        write.path.endsWith("/reactions");
      expect(github.filter((write) => !reaction(write))).toEqual(writes);
      if (!mayReact) expect(github.filter(reaction)).toEqual([]);
    },
  );
});
