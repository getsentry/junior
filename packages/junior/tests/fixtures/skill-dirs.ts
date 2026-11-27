import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getChatConfig, installChatConfig } from "@/chat/config";

type TestSkill = {
  name: string;
  description: string;
  body: string;
  disableModelInvocation?: boolean;
};

/**
 * Install skills in a temporary skill root, set as the only configured skill
 * dir. The returned function restores the previous config and removes the
 * root.
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
  const config = getChatConfig();
  const previous = installChatConfig({ ...config, skills: { dirs: [root] } });
  return async () => {
    installChatConfig(previous);
    await fs.rm(root, { recursive: true, force: true });
  };
}
