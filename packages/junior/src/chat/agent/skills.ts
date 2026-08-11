/** Run-scoped skill discovery and explicit invocation. */
import { logInfo } from "@/chat/logging";
import { discoverSkills, type Skill, type SkillMetadata } from "@/chat/skills";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
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

/** Load the skill explicitly invoked by the current instruction. */
export async function loadInvokedSkill(args: {
  activeSkills: Skill[];
  invokedSkill: SkillMetadata | null;
  skillSandbox: SkillSandbox;
}): Promise<Skill | null> {
  if (!args.invokedSkill) {
    return null;
  }
  const loadedSkill = await args.skillSandbox.loadSkill(args.invokedSkill.name);
  if (loadedSkill) {
    upsertActiveSkill(args.activeSkills, loadedSkill);
  }
  return loadedSkill;
}
