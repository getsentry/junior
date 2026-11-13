import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type TestSkill = {
  name: string;
  description: string;
  body: string;
  disableModelInvocation?: boolean;
};

/**
 * Install skills in a temporary `SKILL_DIRS` root. The returned function
 * restores `SKILL_DIRS` and removes the root.
 */
export async function installTestSkills(
  skills: TestSkill[],
): Promise<() => Promise<void>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "junior-test-skills-"));
  for (const skill of skills) {
    const dir = path.join(root, skill.name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      [
        "---",
        `name: ${skill.name}`,
        `description: ${skill.description}`,
        ...(skill.disableModelInvocation
          ? ["disable-model-invocation: true"]
          : []),
        "---",
        "",
        skill.body,
        "",
      ].join("\n"),
    );
  }
  const previous = process.env.SKILL_DIRS;
  process.env.SKILL_DIRS = root;
  return async () => {
    if (previous === undefined) delete process.env.SKILL_DIRS;
    else process.env.SKILL_DIRS = previous;
    await fs.rm(root, { recursive: true, force: true });
  };
}
