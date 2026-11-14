/**
 * The sdk-repro suite: the coding suite's plugins with only the sdk-repro
 * skill. A separate suite keeps the skill out of the coding suite's tool
 * descriptions, which list every installed skill.
 *
 * `fixtures/sdk-repro-skills/sdk-repro/SKILL.md` is a copy of
 * `app/skills/sdk-repro/SKILL.md` in getsentry/junior-prod at
 * ed46d09a454640b493f6e849787ee2e5beb4fb5b, with Prettier formatting. Copy it
 * again when the skill changes a flow that these tests cover.
 */
import path from "node:path";

const evalsPackageRoot = path.resolve(__dirname, "../..");

/** Project settings of the sdk-repro suite. The config adds `include`. */
export const sdkReproSuite = {
  name: "sdk-repro",
  env: {
    SKILL_DIRS: path.resolve(evalsPackageRoot, "fixtures/sdk-repro-skills"),
  },
  provide: {
    agentOptionsModule: path.resolve(__dirname, "coding-agent-options.ts"),
  },
};
