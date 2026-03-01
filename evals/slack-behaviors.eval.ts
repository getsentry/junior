import { describe, expect } from "vitest";
import { slackEval, mention, threadMessage, threadStart } from "./helpers";

describe("Slack Behavior Evals", () => {

  slackEval("subscribed skip", {
    behavior: { subscribed_decisions: [{ should_reply: false, reason: "side conversation" }] },
    events: [threadMessage("thanks everyone")],
    assert: (result) => {
      expect(result.posts).toHaveLength(0);
    },
    criteria: "No reply should be posted when the subscription decision is to skip.",
  });

  slackEval("explicit mention forces reply", {
    events: [threadMessage("<@U_APP> what is 2+2?", { is_mention: true })],
    assert: (result) => {
      expect(result.posts).toHaveLength(1);
    },
    criteria: "Exactly one reply that contains the number 4.",
  });

  const continuityThread = { id: "thread-continuity", channel_id: "C-continuity", thread_ts: "17000000.continuity" };

  slackEval("multi-turn continuity", {
    events: [
      mention("I need the budget by Friday.", { thread: continuityThread }),
      threadMessage("what did i just ask?", { thread: continuityThread, is_mention: true }),
    ],
    assert: (result) => {
      expect(result.posts).toHaveLength(2);
    },
    criteria: "Two replies. The second reply references the budget or Friday.",
  });

  slackEval("assistant thread init metadata", {
    events: [threadStart()],
    assert: (result) => {
      expect(result.posts).toHaveLength(0);
      expect(result.slackAdapter.titleCalls).toHaveLength(1);
      expect(result.slackAdapter.promptCalls).toHaveLength(1);
    },
    criteria: "No posts. Title and suggested prompts each set exactly once.",
  });

  slackEval("handler error fallback", {
    behavior: { fail_reply_call: 1 },
    events: [mention("What's the status of the deploy?")],
    assert: (result) => {
      expect(result.posts).toHaveLength(1);
    },
    criteria: "One post containing an error message.",
  });

  slackEval("candidate-brief skill invocation", {
    behavior: { skill_dirs: ["evals/skills"] },
    events: [mention("/candidate-brief David Cramer")],
    assert: (result) => {
      expect(result.posts).toHaveLength(1);
      expect(result.posts[0]).toContain("David Cramer");
      expect(result.posts[0]).toContain("CPO");
    },
    criteria: "Posts a brief for David Cramer showing role CPO, team Executive, location San Francisco.",
  });

  const candidateBriefThread = { id: "thread-candidate-brief-repeat", channel_id: "C-candidate-brief", thread_ts: "17000000.candidate-brief" };

  slackEval("candidate-brief repeated invocations", {
    behavior: { skill_dirs: ["evals/skills"] },
    events: [
      mention("/candidate-brief Alice Example", { thread: candidateBriefThread }),
      threadMessage("/candidate-brief Bob Example", { thread: candidateBriefThread, is_mention: true }),
    ],
    assert: (result) => {
      expect(result.posts).toHaveLength(2);
      expect(result.posts[0]).toContain("Alice Example");
      expect(result.posts[1]).toContain("Bob Example");
    },
    criteria: "Two briefs — one for Alice (Engineer, Platform) and one for Bob (Designer, Product).",
  });

  slackEval("list-working-directory skill", {
    behavior: { skill_dirs: ["evals/skills"] },
    events: [mention("/list-working-directory")],
    assert: (result) => {
      expect(result.posts).toHaveLength(1);
      expect(result.turns.flatMap((t) => t.tool_calls)).toContain("bash");
      expect(result.turns.some((t) => t.sandbox_id !== null)).toBe(true);
      expect(result.posts[0]).toContain("Working directory files:");
    },
    criteria: "Runs bash in a sandbox and posts a file listing.",
  });

  slackEval("capability credential smoke", {
    behavior: { skill_dirs: ["evals/skills"], enable_test_credentials: true, test_credential_token: "eval-smoke-token" },
    events: [mention("/capability-credential-smoke")],
    assert: (result) => {
      expect(result.posts).toHaveLength(1);
      expect(result.turns.flatMap((t) => t.tool_calls)).toContain("bash");
      expect(result.posts[0]).toContain("CREDENTIAL_OK");
    },
    criteria: "Runs bash with test credentials and outputs CREDENTIAL_OK.",
  });

  const defaultRepoThread = { id: "thread-default-repo", channel_id: "C-default-repo", thread_ts: "17000000.default-repo" };

  slackEval("sentry capability credential smoke", {
    behavior: { skill_dirs: ["evals/skills"], enable_test_credentials: true, test_credential_token: "eval-sentry-token" },
    events: [mention("/sentry-credential-smoke")],
    assert: (result) => {
      expect(result.posts).toHaveLength(1);
      expect(result.turns.flatMap((t) => t.tool_calls)).toContain("bash");
      expect(result.posts[0]).toContain("CREDENTIAL_OK");
    },
    criteria: "Runs bash with test credentials for Sentry and outputs CREDENTIAL_OK.",
  });

  slackEval("set default repo via natural language", {
    behavior: { enable_test_credentials: true, test_credential_token: "eval-default-repo-token" },
    events: [
      mention("Set the default repo to getsentry/junior for this channel.", { thread: defaultRepoThread }),
      threadMessage("Now enable github issues read credentials without passing --repo.", { thread: defaultRepoThread, is_mention: true }),
    ],
    assert: (result) => {
      expect(result.posts).toHaveLength(2);
      expect(result.turns.flatMap((t) => t.tool_calls)).toContain("bash");
    },
    criteria: "First turn sets default repo. Second turn issues credentials without --repo.",
  });

});
