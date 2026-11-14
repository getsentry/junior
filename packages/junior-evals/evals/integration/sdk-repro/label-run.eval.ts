import { describe, expect } from "vitest";
import { readGitHubSdkReproWrites } from "@junior-evals/fixture/github";
import { githubWebhook } from "@junior-evals/fixture/inputs";
import {
  insertEventAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { toolCallsOf } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// The fake GitHub serves this repository's issues #11 to #13
// (`packages/junior-testing/src/http/github-sdk-repro.ts`).
const repo = "getsentry/sdk-repro-test-python";
const maintainer = { id: 20001, login: "sdk-maintainer" };

describe("sdk-repro label runs", () => {
  test.for([
    {
      // Only `linear-code[bot]` may start a run.
      stop: "requester not allowed",
      issue: 11,
      sender: { id: 29139614, login: "renovate[bot]" },
      writes: [],
      mayReact: false,
    },
    {
      // Open PR #14 says `resolves: #12`.
      stop: "existing work",
      issue: 12,
      sender: maintainer,
      writes: [
        {
          method: "POST",
          path: `/repos/${repo}/issues/12/comments`,
          body: {
            body: expect.stringMatching(
              /^<!-- sdk-repro -->\n[\s\S]*(pull\/14|#14\b)/,
            ),
          },
        },
      ],
      mayReact: true,
    },
    {
      // A progress comment from 30 minutes ago.
      stop: "run in progress",
      issue: 13,
      sender: maintainer,
      writes: [],
      mayReact: true,
    },
  ])(
    "when the issue has $stop, stop before the Workspace",
    async ({ issue, mayReact, sender, stop, writes }, { run }) => {
      const destination = slackChannel();
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

      const delivery = await run(
        githubWebhook("issues", {
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
        }),
      );

      expect(delivery.replies).toEqual([
        expect.objectContaining({
          channelId: destination.channelId,
          text: expect.stringContaining(`stopped: ${stop}`),
        }),
      ]);
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
