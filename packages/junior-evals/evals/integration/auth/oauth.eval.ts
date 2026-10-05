import { describe, expect } from "vitest";
import {
  completeAuth,
  mention,
  threadMessage,
} from "@junior-evals/fixture/inputs";
import { insertCredential } from "@junior-evals/fixture/insert";
import { rubric } from "@junior-evals/fixture/judge";
import {
  completedMcpToolCalls,
  completedToolCalls,
  toolOutput,
} from "@junior-evals/fixture/results";
import { test, type Conversation } from "@junior-evals/fixture/test";

const BUDGET_ECHO = "mcp__eval-auth__budget-echo";

/** Commands that the provider answered with the connected account. */
function identityChecks(...conversations: Conversation[]) {
  return completedToolCalls("bash", ...conversations).filter((call) =>
    JSON.stringify(toolOutput(call)).includes("eval-oauth-user"),
  );
}

function skillLoads(skillName: string, ...conversations: Conversation[]) {
  return completedToolCalls("loadSkill", ...conversations).filter(
    (call) =>
      (call.input as { skill_name?: unknown } | undefined)?.skill_name ===
      skillName,
  );
}

function turnStates(conversation: Conversation) {
  return conversation.turns.map((turn) => turn.status);
}

describe("OAuth Workflows", () => {
  test("when MCP auth pauses a turn, resume and reuse the stored credential on the next turn", async ({
    run,
  }) => {
    const paused = await run(
      mention(
        "/eval-auth Connect, then tell me the budget deadline I mentioned.",
      ),
      { history: [threadMessage("Remember: the budget deadline is Friday.")] },
    );
    expect(turnStates(paused)).toEqual(["started"]);

    const resumed = await paused.continue(completeAuth("eval-auth"), {
      criteria: rubric({
        pass: [
          "The answer explicitly says the earlier budget deadline was Friday.",
        ],
        fail: [
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "After authorization completes, do not claim Eval Auth is unavailable, ask the user to reconnect, or post a generic failure message.",
        ],
      }),
    });
    expect(turnStates(resumed)).toEqual(["succeeded"]);
    expect(completedMcpToolCalls(BUDGET_ECHO, resumed)).toHaveLength(1);

    const reused = await resumed.continue(
      mention(
        "/eval-auth Use the connection again and confirm the lookup works.",
      ),
      {
        criteria: rubric({
          pass: [
            "The request completes successfully using the Eval Auth connection.",
          ],
          fail: [
            "Do not claim Eval Auth is unavailable, ask the user to reconnect, or post a generic failure message.",
          ],
        }),
      },
    );
    // The turn does not wait for authorization again.
    expect(turnStates(reused)).toEqual(["succeeded"]);
    expect(completedMcpToolCalls(BUDGET_ECHO, reused)).toHaveLength(1);
  });

  test("when generic OAuth pauses a turn, resume and reuse the stored credential on the next turn", async ({
    run,
  }) => {
    const paused = await run(
      mention(
        "/eval-oauth Connect, then tell me the budget deadline I mentioned.",
      ),
      { history: [threadMessage("Remember: the budget deadline is Friday.")] },
    );
    expect(turnStates(paused)).toEqual(["started"]);
    expect(identityChecks(paused)).toEqual([]);

    const resumed = await paused.continue(completeAuth("eval-oauth"), {
      criteria: rubric({
        pass: [
          "The answer explicitly says the earlier budget deadline was Friday.",
        ],
        fail: [
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "After authorization completes, do not claim eval-oauth is unavailable, ask the user to reconnect, or post a generic failure message.",
        ],
      }),
    });
    expect(turnStates(resumed)).toEqual(["succeeded"]);
    expect(identityChecks(resumed)).not.toHaveLength(0);

    const reused = await resumed.continue(
      mention(
        "/eval-oauth Check again and tell me which eval identity is active.",
      ),
      {
        criteria: rubric({
          pass: [
            "The answer identifies the connected account as eval-oauth-user.",
          ],
          fail: [
            "Do not claim eval-oauth is unavailable, ask the user to reconnect, or post a generic failure message.",
          ],
        }),
      },
    );
    // The turn does not wait for authorization again.
    expect(turnStates(reused)).toEqual(["succeeded"]);
    expect(identityChecks(reused)).not.toHaveLength(0);
    // `/eval-oauth` gives the skill to the agent, so the agent does not load it.
    expect(skillLoads("eval-oauth", paused, resumed, reused)).toEqual([]);
  });

  test("when OAuth pauses a turn in a direct message, send the link there and resume", async ({
    run,
  }) => {
    const paused = await run(
      mention("/eval-oauth Tell me which eval identity is active.", {
        channelType: "im",
      }),
    );
    expect(turnStates(paused)).toEqual(["started"]);
    expect(identityChecks(paused)).toEqual([]);

    const resumed = await paused.continue(completeAuth("eval-oauth"));
    expect(turnStates(resumed)).toEqual(["succeeded"]);
    expect(identityChecks(resumed)).not.toHaveLength(0);
  });

  test("refreshes an expired generic OAuth credential during a normal turn", async ({
    run,
  }) => {
    // The provider accepts only the access token that a refresh returns.
    await insertCredential({
      accessToken: "expired-eval-oauth-access-token",
      expired: true,
      provider: "eval-oauth",
      refreshToken: "eval-oauth-refresh-token",
      scope: "read",
    });

    const conversation = await run(
      mention("/eval-oauth Tell me which eval identity is currently active."),
    );

    // The turn does not wait for authorization.
    expect(turnStates(conversation)).toEqual(["succeeded"]);
    expect(identityChecks(conversation)).not.toHaveLength(0);
    expect(conversation.replies.at(-1)?.text).toMatch(/eval-oauth-user/i);
  });

  test("when the user explicitly asks to connect, confirm the completed connection", async ({
    run,
  }) => {
    const paused = await run(
      mention("Connect my eval-oauth account so I can use it here."),
    );
    expect(turnStates(paused)).toEqual(["started"]);

    const resumed = await paused.continue(completeAuth("eval-oauth"), {
      criteria: rubric({
        pass: [
          "After authorization completes, the assistant briefly confirms that the eval-oauth account is ready to use.",
        ],
        fail: [
          "Do not ask the user to authorize again after the connection has already completed.",
          "Do not post a generic failure message.",
          "Do not invent or continue with an unrelated task after confirming the connection.",
        ],
      }),
    });
    expect(turnStates(resumed)).toEqual(["succeeded"]);
    expect(skillLoads("eval-oauth", paused, resumed)).not.toHaveLength(0);
    expect(identityChecks(resumed)).not.toHaveLength(0);
  });
});
