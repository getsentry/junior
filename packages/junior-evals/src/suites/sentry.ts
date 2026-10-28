/**
 * The Sentry suite: the Sentry plugin and no other plugin or skill.
 *
 * A suite is a Vitest project for one directory. It sets the default agent
 * options for its tests. See `src/fixture/test.ts`.
 */
import path from "node:path";

/** Project settings of the Sentry suite. The config adds `include`. */
export const sentrySuite = {
  name: "sentry",
  provide: {
    agentOptionsModule: path.resolve(__dirname, "sentry-agent-options.ts"),
  },
};
