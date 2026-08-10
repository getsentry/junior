import { describeEval, toolCalls } from "vitest-evals";
import { beforeAll, expect } from "vitest";
import {
  mention,
  resourceEventNotification,
  rubric,
  slackEvals,
  threadMessage,
} from "../../src/helpers";
import { warmSandboxSnapshot } from "../../src/snapshot-warmup";

const SNAPSHOT_WARMUP_TIMEOUT_MS = 10 * 60 * 1000;

describeEval("GitHub Skill Workflows", slackEvals, (it) => {
  // Keep one-time sandbox setup outside the 60-second behavior budget.
  beforeAll(async () => {
    await warmSandboxSnapshot();
  }, SNAPSHOT_WARMUP_TIMEOUT_MS);

  it("when subscribed PR checks fail headlessly, commit and push the fix", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        skill_dirs: ["fixtures/github-headless-skills"],
      },
      initialEvents: [
        resourceEventNotification({
          eventType: "pull_request.checks.failed",
          intent:
            "Fix failing checks on this pull request and push the update.",
          label: "Fixture PR #42",
          identifier: "local/headless-fixture#42",
          trustedSummary:
            'The build expects skills/github-headless-pr-fixture/project/src/status.ts to export buildStatus = "fixed". Apply the fix, commit it, push the pull request branch, and verify the result.',
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant handles the subscribed event without asking a human to authorize GitHub.",
          "The fixture status is changed from broken to fixed, committed, and pushed to the existing pull request branch.",
          "The assistant reports that the remote branch contains the pushed fix.",
        ],
        fail: [
          "Do not ask for OAuth, a personal access token, approval, or another human action before fixing the subscribed pull request.",
          "Do not stop after describing a plan or editing the file without committing and pushing it.",
          "Do not contact production GitHub or use a non-local remote.",
        ],
      }),
    });

    const verifyCall = toolCalls(result.session).find(
      (call) =>
        call.name === "bash" &&
        call.status === "ok" &&
        JSON.stringify(call.result)?.includes(
          "verified remote branch contains the pushed fix",
        ) === true,
    );
    expect(verifyCall).toMatchObject({ result: { ok: true } });
  });

  it("when an interrupted push applied remotely, verify it and do not push again", async ({
    run,
  }) => {
    const pushTool = "mcp__eval-operation__release-push";
    const statusTool = "mcp__eval-operation__release-status";
    const result = await run({
      overrides: {
        plugin_dirs: ["fixtures/plugins"],
        timeout_resume: {
          tool_name: "callMcpTool",
          arguments: { tool_name: pushTool, arguments: {} },
        },
      },
      initialEvents: [
        mention(
          "/eval-operation The release push timed out, so I don't know whether it landed. Please finish the release safely and tell me the final remote status.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant reports that the remote release status is shipped.",
          "The final answer is based on the observed remote state rather than treating the interrupted command as a confirmed failure.",
        ],
        fail: [
          "Do not ask for OAuth, a token, or changed GitHub permissions for the local fixture.",
          "Do not contact production GitHub.",
        ],
      }),
    });

    const calls = toolCalls(result.session);
    const pushCalls = calls.filter(
      (call) =>
        call.name === "callMcpTool" && call.arguments?.tool_name === pushTool,
    );
    const statusCall = calls.find(
      (call) =>
        call.name === "callMcpTool" &&
        call.status === "ok" &&
        call.arguments?.tool_name === statusTool,
    );

    expect(pushCalls).toHaveLength(0);
    expect(statusCall).toBeDefined();
  });

  it("when asked about PR auth sequencing, explain automatic installation credentials", async ({
    run,
  }) => {
    await run({
      overrides: {
        plugin_packages: ["@sentry/junior-github"],
        skill_dirs: ["../junior/skills"],
      },
      initialEvents: [
        mention(
          "/github-code If I ask you to open a PR from an existing branch, do I need to authorize GitHub or provide a token? Also, does the branch get pushed before or after the PR is opened? Keep it short.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The answer says the branch is pushed before the pull request is created.",
          "The answer explains that Junior automatically injects the GitHub App credential for the standard push and pull request workflow, with no user-managed token or authorization step.",
        ],
        fail: [
          "Do not tell the user to grant Pull requests: write, authorize GitHub, provide a token, or take another authentication action for this standard bot workflow.",
          "Do not recommend `gh pr create` for new pull requests.",
          "Do not imply that pull request creation credentials alone are sufficient before the push.",
        ],
      }),
    });
  });

  const defaultRepoThread = {
    id: "thread-default-repo",
    channel_id: "CDEFAULTREPO",
    thread_ts: "17000000.1401",
  };
  const targetClassificationContextThread = {
    id: "thread-target-classification-context",
    channel_id: "CTARGETCLASSIFICATIONCONTEXT",
    thread_ts: "17000000.1402",
  };
  const targetClassificationExplicitThread = {
    id: "thread-target-classification-explicit",
    channel_id: "CTARGETCLASSIFICATIONEXPLICIT",
    thread_ts: "17000000.1403",
  };

  it("when a default repo is set in one turn, reuse it in the next turn without asking again", async ({
    run,
  }) => {
    await run({
      overrides: {
        plugin_packages: ["@sentry/junior-github"],
        skill_dirs: ["../junior/skills"],
      },
      initialEvents: [
        mention("Set the default repo to getsentry/junior for this channel.", {
          thread: defaultRepoThread,
        }),
      ],
      events: [
        threadMessage(
          "Now tell me which GitHub repo you'd use for issue commands when I don't name one.",
          {
            thread: defaultRepoThread,
            is_mention: true,
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant confirms default repo setup and later says issue commands without an explicit repo would use getsentry/junior.",
        ],
        fail: [
          "Do not ask the user to provide the repo again.",
          "Do not say a live GitHub lookup is required before answering.",
        ],
      }),
    });
  });

  it("when drafting a fake issue from contextual foreign reference, keep the default repo as target", async ({
    run,
  }) => {
    await run({
      overrides: {
        plugin_packages: ["@sentry/junior-github"],
        skill_dirs: ["../junior/skills"],
      },
      initialEvents: [
        threadMessage(
          "Set the default repo to getsentry/junior-eval-bot-never-exists for this channel.",
          {
            thread: targetClassificationContextThread,
            is_mention: true,
          },
        ),
      ],
      events: [
        threadMessage(
          "We need a tracking issue for the Junior bot. Use getsentry/junior-eval-reference-never-exists#123 as background. Draft the target repo, title, and body for me to review—don't create anything yet.",
          {
            thread: targetClassificationContextThread,
            is_mention: true,
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant confirms default repo setup and drafts the requested issue against getsentry/junior-eval-bot-never-exists.",
          "The foreign issue reference is treated only as context if it appears in the answer.",
          "No GitHub issue is created for this draft-only request.",
        ],
        fail: [
          "Do not choose getsentry/junior-eval-reference-never-exists as the action target.",
          "Do not create or comment on a GitHub issue for either fake repo.",
          "Do not ask the user to provide the repo again.",
        ],
      }),
    });
  });

  it("when confirming a fake explicit issue reference, use that issue as target", async ({
    run,
  }) => {
    await run({
      overrides: {
        plugin_packages: ["@sentry/junior-github"],
        skill_dirs: ["../junior/skills"],
      },
      initialEvents: [
        threadMessage(
          "Set the default repo to getsentry/junior-eval-bot-never-exists for this channel.",
          {
            thread: targetClassificationExplicitThread,
            is_mention: true,
          },
        ),
      ],
      events: [
        threadMessage(
          "Before I approve a later comment, confirm the target issue for getsentry/junior-eval-reference-never-exists#123. Don't change anything yet.",
          {
            thread: targetClassificationExplicitThread,
            is_mention: true,
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "After confirming default repo setup, the assistant recognizes the explicitly referenced issue as the action target.",
          "No GitHub issue is created or commented on for this confirmation-only request.",
        ],
        fail: [
          "Do not choose getsentry/junior-eval-bot-never-exists as the action target.",
          "Do not create or comment on a GitHub issue for either fake repo.",
          "Do not ask the user to restate the repository or issue number.",
        ],
      }),
    });
  });
});
