/**
 * The test API for tests that run the agent.
 *
 * `run()` starts a new Conversation on the test's agent. `agent(options)`
 * creates that agent with `createApp()` options; without it, the agent uses
 * the default options. All Conversations of a test use the same agent.
 */
import { test as baseTest } from "vitest";
// Register the `toSatisfyJudge()` matcher for `conversation.evalRun`.
import "vitest-evals";
import type { JuniorAppOptions } from "@/app";
import { runEvalWork } from "../eval-work";
import { createFixtureAgent, type FixtureAgent, type RunAgent } from "./agent";

export type {
  CallOptions,
  Conversation,
  RunAgent,
  TurnProgress,
} from "./agent";
export type { Reply, ToolCall, Turn, TurnStatus } from "./results";

interface AgentFixtures {
  /** Create the test's agent with `createApp()` options. */
  agent: (options?: JuniorAppOptions) => Promise<{ run: RunAgent }>;
  /** Start a new Conversation on the test's agent. */
  run: RunAgent;
}

/** Vitest `test` with the agent fixtures. */
export const test = baseTest.extend<AgentFixtures>({
  agent: async ({ signal, task }, use) => {
    let created: FixtureAgent | undefined;
    await use(async (options = {}) => {
      if (created) {
        throw new Error("A test has one agent; call agent() once");
      }
      created = await createFixtureAgent(options, { signal, task });
      const agent = created;
      return {
        run: (input, callOptions) =>
          runEvalWork(() => agent.run(input, callOptions)),
      };
    });
    await created?.close();
  },
  run: async ({ agent }, use) => {
    let run: RunAgent | undefined;
    await use(async (input, options) => {
      run ??= (await agent()).run;
      return await run(input, options);
    });
  },
});
