/**
 * The auth suite: two plugins that need authorization with their skills, and
 * one plugin that needs none.
 *
 * A suite is a Vitest project for one directory. It sets the default agent
 * options for its tests. See `src/fixture/test.ts`.
 */
import path from "node:path";

const evalsPackageRoot = path.resolve(__dirname, "../..");

/** Project settings of the auth suite. The config adds `include`. */
export const authSuite = {
  name: "auth",
  // The host setting that production reads for skill directories.
  env: {
    SKILL_DIRS: path.resolve(evalsPackageRoot, "fixtures/auth-skills"),
  },
  provide: {
    agentOptionsModule: path.resolve(__dirname, "auth-agent-options.ts"),
  },
};
