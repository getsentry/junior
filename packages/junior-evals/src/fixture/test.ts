/**
 * The test API for tests that run the agent.
 *
 * `run()` starts a new Conversation on the test's agent. `agent(options)`
 * creates that agent with `createApp()` options; without it, the agent uses
 * the default options. All Conversations of a test use the same agent.
 * `redeploy(options)` replaces its app with new options, as a deploy does,
 * and the Conversations of the test continue on the new app.
 *
 * A suite is a Vitest project for one directory. It provides
 * `agentOptionsModule`, a module whose default export is the suite's default
 * `createApp()` options. Options passed to `agent()` or `redeploy()` replace
 * those defaults key by key.
 */
import { test as baseTest } from "vitest";
// Register the `toSatisfyJudge()` matcher for call results.
import "vitest-evals";
import type { JuniorAppOptions } from "@/app";
import { runEvalWork } from "../eval-work";
import { createFixtureAgent, type FixtureAgent } from "./agent";
import type { RunAgent } from "./call";

export type { CallOptions, Conversation, RunAgent, TurnProgress } from "./call";
export type { Reply, ToolCall, Turn, TurnStatus } from "./results";

declare module "vitest" {
  export interface ProvidedContext {
    /** Path of the module with the suite's default `createApp()` options. */
    agentOptionsModule?: string;
  }
}

/** The test's agent. */
interface TestAgent {
  run: RunAgent;
  /** Replace the agent's app with one that has these `createApp()` options. */
  redeploy: (options?: JuniorAppOptions) => Promise<void>;
  /** Create a public Space as another person. The web person is not in it. */
  createOtherSpace: (name: string) => Promise<{ id: string }>;
  /** Read the Space of a Conversation as the web person sees it. */
  readConversationSpace: (
    conversationId: string,
  ) => Promise<{ id: string; name: string } | null>;
}

interface AgentFixtures {
  /** Create the test's agent with `createApp()` options. */
  agent: (options?: JuniorAppOptions) => Promise<TestAgent>;
  /** Path of the module with the suite's default `createApp()` options. */
  agentOptionsModule: string | undefined;
  /** Start a new Conversation on the test's agent. */
  run: RunAgent;
}

/** Vitest `test` with the agent fixtures. */
export const test = baseTest.extend<AgentFixtures>({
  agentOptionsModule: [undefined, { injected: true }],
  agent: async ({ agentOptionsModule, task }, use) => {
    let created: FixtureAgent | undefined;
    await use(async (options = {}) => {
      if (created) {
        throw new Error("A test has one agent; call agent() once");
      }
      const defaults: JuniorAppOptions = agentOptionsModule
        ? ((await import(agentOptionsModule)) as { default: JuniorAppOptions })
            .default
        : {};
      created = await createFixtureAgent({ ...defaults, ...options }, { task });
      const agent = created;
      return {
        run: (input, callOptions) =>
          runEvalWork(() => agent.run(input, callOptions)),
        redeploy: (next = {}) =>
          runEvalWork(() => agent.redeploy({ ...defaults, ...next })),
        createOtherSpace: (name) =>
          runEvalWork(() => agent.createOtherSpace(name)),
        readConversationSpace: (conversationId) =>
          runEvalWork(() => agent.readConversationSpace(conversationId)),
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
