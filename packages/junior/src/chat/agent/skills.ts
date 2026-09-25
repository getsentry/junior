/** Run-scoped skill discovery and explicit invocation. */
import { logInfo } from "@/chat/logging";
import { discoverSkills, type Skill, type SkillMetadata } from "@/chat/skills";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import type { PiMessage } from "@/chat/pi/messages";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";

let startupDiscoveryLogged = false;

/** Upsert a skill into the active skills list by name. */
export function upsertActiveSkill(activeSkills: Skill[], next: Skill): void {
  const existing = activeSkills.find((skill) => skill.name === next.name);
  if (existing) {
    existing.body = next.body;
    existing.description = next.description;
    existing.skillPath = next.skillPath;
    existing.allowedTools = next.allowedTools;
    existing.pluginProvider = next.pluginProvider;
    return;
  }

  activeSkills.push(next);
}

/** Discover skills for one slice; emits the startup discovery summary once per process. */
export async function discoverRunSkills(args: {
  skillDirs?: string[];
}): Promise<SkillMetadata[]> {
  const availableSkills = await discoverSkills({
    additionalRoots: args.skillDirs,
  });
  if (!startupDiscoveryLogged) {
    startupDiscoveryLogged = true;
    const plugins = pluginCatalogRuntime.getProviders();
    const roots = [
      ...new Set(availableSkills.map((skill) => skill.skillPath)),
    ].sort();
    logInfo("startup.discovery.completed", {
      "app.skill.count": availableSkills.length,
      "app.skill.names": availableSkills.map((skill) => skill.name).sort(),
      "app.file.directories": roots,
      "app.plugin.count": plugins.length,
      "app.plugin.names": plugins.map((plugin) => plugin.manifest.name).sort(),
    });
  }
  return availableSkills;
}

function lastLoadedSkillName(messages: readonly PiMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      details?: unknown;
      isError?: unknown;
      role?: unknown;
      skill_name?: unknown;
      toolName?: unknown;
    };
    if (
      message.role !== "toolResult" ||
      message.toolName !== "loadSkill" ||
      message.isError === true
    ) {
      continue;
    }
    const details = message.details;
    const skillName =
      details && typeof details === "object" && "skill_name" in details
        ? (details as { skill_name?: unknown }).skill_name
        : message.skill_name;
    if (typeof skillName === "string" && skillName.trim()) {
      return skillName;
    }
  }
  return undefined;
}

/** Load the explicit skill, or recover the last skill loaded in a resumed turn. */
export async function loadRunSkill(args: {
  activeSkills: Skill[];
  currentTurnMessages: readonly PiMessage[];
  invokedSkill: SkillMetadata | null;
  resumed: boolean;
  skillSandbox: SkillSandbox;
}): Promise<Skill | null> {
  const skillName =
    args.invokedSkill?.name ??
    (args.resumed ? lastLoadedSkillName(args.currentTurnMessages) : undefined);
  if (!skillName) {
    return null;
  }
  const loadedSkill = await args.skillSandbox.loadSkill(skillName);
  if (loadedSkill) {
    upsertActiveSkill(args.activeSkills, loadedSkill);
  }
  return loadedSkill;
}
