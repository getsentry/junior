/**
 * The test API for tests that run the agent.
 *
 * `run()` starts a new Conversation on the test's agent. `agent(options)`
 * creates that agent with `createApp()` options; without it, the agent uses
 * the default options. All Conversations of a test use the same agent.
 *
 * A suite is a Vitest project for one directory. It provides
 * `agentOptionsModule`, a module whose default export is the suite's default
 * `createApp()` options. Options passed to `agent()` replace those defaults
 * key by key.
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

declare module "vitest" {
  export interface ProvidedContext {
    /** Path of the module with the suite's default `createApp()` options. */
    agentOptionsModule?: string;
  }
}

interface AgentFixtures {
  /** Create the test's agent with `createApp()` options. */
  agent: (
    options?: JuniorAppOptions,
  ) => Promise<Pick<FixtureAgent, "run" | "setDistillationPreference">>;
  /** Path of the module with the suite's default `createApp()` options. */
  agentOptionsModule: string | undefined;
  /** Start a new Conversation on the test's agent. */
  run: RunAgent;
}

/** Vitest `test` with the agent fixtures. */
export const test = baseTest.extend<AgentFixtures>({
  agentOptionsModule: [undefined, { injected: true }],
  agent: async ({ agentOptionsModule, signal, task }, use) => {
    let created: FixtureAgent | undefined;
    await use(async (options = {}) => {
      if (created) {
        throw new Error("A test has one agent; call agent() once");
      }
      const defaults: JuniorAppOptions = agentOptionsModule
        ? ((await import(agentOptionsModule)) as { default: JuniorAppOptions })
            .default
        : {};
      created = await createFixtureAgent(
        { ...defaults, ...options },
        { signal, task },
      );
      const agent = created;
      return {
        run: (input, callOptions) =>
          runEvalWork(() => agent.run(input, callOptions)),
        setDistillationPreference: agent.setDistillationPreference,
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
