/**
 * The memory suite: the memory plugin and no other plugin or skill.
 *
 * A suite is a Vitest project for one directory. It sets the default agent
 * options for its tests. See `src/fixture/test.ts`.
 */
import path from "node:path";

/** Project settings of the memory suite. The config adds `include`. */
export const memorySuite = {
  name: "memory",
  provide: {
    agentOptionsModule: path.resolve(__dirname, "memory-agent-options.ts"),
  },
};
