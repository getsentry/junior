/**
 * The skills suite: the fixture skills, the skills of the Agent Browser
 * plugin, and two eval plugins with MCP tools.
 *
 * A suite is a Vitest project for one directory. It sets the default agent
 * options for its tests. See `src/fixture/test.ts`.
 */
import path from "node:path";

const evalsPackageRoot = path.resolve(__dirname, "../..");

/** Project settings of the skills suite. The config adds `include`. */
export const skillsSuite = {
  name: "skills",
  // The host setting that production reads for skill directories. The Agent
  // Browser plugin itself is not installed: its sandbox packages take minutes
  // to install, and these tests only check which skill the agent loads.
  env: {
    SKILL_DIRS: [
      path.resolve(evalsPackageRoot, "fixtures/skills"),
      path.resolve(evalsPackageRoot, "../junior-agent-browser/skills"),
    ].join(path.delimiter),
  },
  provide: {
    agentOptionsModule: path.resolve(__dirname, "skills-agent-options.ts"),
  },
};
