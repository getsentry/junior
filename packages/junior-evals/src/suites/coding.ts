/**
 * The coding suite: the GitHub and memory plugins and the coding skills.
 *
 * A suite is a Vitest project for one directory. It sets the default agent
 * options for its tests. See `src/fixture/test.ts`. The integration and
 * behavioral configs each run this suite on their own directory, so the
 * settings are here and not in one config.
 */
import path from "node:path";

const evalsPackageRoot = path.resolve(__dirname, "../..");

/** Project settings of the coding suite. The config adds `include`. */
export const codingSuite = {
  name: "coding",
  // The host setting that production reads for skill directories.
  env: {
    SKILL_DIRS: path.resolve(evalsPackageRoot, "fixtures/coding-skills"),
  },
  provide: {
    agentOptionsModule: path.resolve(__dirname, "coding-agent-options.ts"),
  },
};
