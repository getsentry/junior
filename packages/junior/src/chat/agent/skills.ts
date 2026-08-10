/**
 * Run-scoped skill discovery and restore.
 *
 * Discovers the skills available to one run slice and rehydrates active skill
 * handles from durable Pi history and explicit invocation, so resumed slices
 * keep the skill state the conversation already established.
 */
import { logInfo } from "@/chat/logging";
import { discoverSkills, type Skill, type SkillMetadata } from "@/chat/skills";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { inferLoadedSkillNamesFromPiMessages } from "@/chat/pi/derived-state";
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

/** Rehydrate active skill handles from durable Pi history and explicit invocation. */
export async function restoreSkillRuntime(args: {
  activeSkills: Skill[];
  invokedSkill: SkillMetadata | null;
  priorPiMessages: PiMessage[] | undefined;
  skillSandbox: SkillSandbox;
}): Promise<void> {
  for (const skillName of inferLoadedSkillNamesFromPiMessages(
    args.priorPiMessages,
  )) {
    const restoredSkill = await args.skillSandbox.loadSkill(skillName);
    if (restoredSkill) {
      upsertActiveSkill(args.activeSkills, restoredSkill);
    }
  }
  if (args.invokedSkill) {
    const restoredSkill = await args.skillSandbox.loadSkill(
      args.invokedSkill.name,
    );
    if (restoredSkill) {
      upsertActiveSkill(args.activeSkills, restoredSkill);
    }
  }
}
