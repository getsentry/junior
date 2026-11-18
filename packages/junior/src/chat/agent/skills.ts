/** Run-scoped skill discovery and explicit invocation. */
import type { AgentRun } from "@/chat/agent/types";
import type { Actor } from "@sentry/junior-plugin-api";
import { dispatchInstructionsInvokeSkills } from "@/chat/conversations/kind-behavior";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { logInfo } from "@/chat/logging";
import { skillReferences } from "@/chat/skill-references";
import { discoverSkills, type Skill, type SkillMetadata } from "@/chat/skills";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import type { PiMessage } from "@/chat/pi/messages";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { readTaskInstructions } from "@/chat/task-input";

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

/**
 * Return the skills that the model can load with `loadSkill`. A manual-only
 * skill is loadable only in a Turn whose message invokes it, or where a skill
 * loaded in that Turn references it as `$name` in its SKILL.md instructions.
 * No other text, such as memory, thread messages, or tool results, unlocks
 * one.
 */
export function loadableSkills(
  availableSkills: SkillMetadata[],
  invokedSkillNames: readonly string[],
  loadedSkills: readonly Skill[],
): SkillMetadata[] {
  const unlocked = new Set([
    ...invokedSkillNames,
    ...loadedSkills.flatMap((loaded) => [
      loaded.name,
      ...skillReferences(loaded.body, availableSkills),
    ]),
  ]);
  return availableSkills.filter(
    (skill) =>
      skill.disableModelInvocation !== true || unlocked.has(skill.name),
  );
}

/**
 * Name the loadable manual-only skills that are not loaded yet.
 * `<available-skills>` leaves them out, so the model sees them only here.
 */
export function unloadedManualSkillNames(
  availableSkills: SkillMetadata[],
  invokedSkillNames: readonly string[],
  loadedSkills: readonly Skill[],
): string[] {
  return loadableSkills(availableSkills, invokedSkillNames, loadedSkills)
    .filter(
      (skill) =>
        skill.disableModelInvocation === true &&
        !loadedSkills.some((loaded) => loaded.name === skill.name),
    )
    .map((skill) => skill.name);
}

/** Discover skills for one slice; emits the startup discovery summary once per process. */
export async function discoverRunSkills(args: {
  skillDirs?: string[] | undefined;
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

/**
 * Return the text whose skill references unlock skills in this Run: the
 * person's own input, or the instructions of an Automation run. Text that no
 * person wrote for this Run, such as Event text, an agent result, a parent
 * agent task, or a plugin dispatch, unlocks nothing.
 */
export function skillInvocationText(
  run: Pick<AgentRun, "dispatch" | "instruction">,
  actor: Actor | undefined,
): string {
  if (run.dispatch) {
    return dispatchInstructionsInvokeSkills(run.dispatch)
      ? (readTaskInstructions(run.instruction.text) ?? "")
      : "";
  }
  const provenance =
    run.instruction.provenance ?? instructionProvenanceFor(actor);
  if (
    provenance.authority !== "instruction" ||
    !provenance.actor ||
    provenance.actor.platform === "system"
  ) {
    return "";
  }
  return (
    run.instruction.inputs ?? [
      { kind: "person" as const, text: run.instruction.text },
    ]
  )
    .filter((input) => input.kind === "person")
    .map((input) => input.text)
    .join("\n\n");
}

function loadedSkillNames(messages: readonly PiMessage[]): string[] {
  return messages.flatMap((entry) => {
    const message = entry as {
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
      return [];
    }
    const details = message.details;
    const skillName =
      details && typeof details === "object" && "skill_name" in details
        ? (details as { skill_name?: unknown }).skill_name
        : message.skill_name;
    return typeof skillName === "string" && skillName.trim() ? [skillName] : [];
  });
}

/**
 * Load the first invoked skill. A resumed slice also restores every skill
 * that loaded earlier in this Turn, so the skills those reference stay
 * loadable. Skills from earlier Turns are never restored. Returns the
 * invoked skill, or else the last restored one.
 */
export async function loadRunSkill(args: {
  activeSkills: Skill[];
  currentTurnMessages: readonly PiMessage[];
  invokedSkills: readonly SkillMetadata[];
  resumed: boolean;
  skillSandbox: SkillSandbox;
}): Promise<Skill | null> {
  const invokedName = args.invokedSkills[0]?.name;
  const names = [
    ...new Set([
      ...(invokedName ? [invokedName] : []),
      ...(args.resumed ? loadedSkillNames(args.currentTurnMessages) : []),
    ]),
  ];
  const loaded = await Promise.all(
    names.map((name) => args.skillSandbox.loadSkill(name)),
  );
  for (const skill of loaded) {
    if (skill) {
      upsertActiveSkill(args.activeSkills, skill);
    }
  }
  if (invokedName) {
    return loaded[0] ?? null;
  }
  return loaded.filter((skill) => skill !== null).at(-1) ?? null;
}
