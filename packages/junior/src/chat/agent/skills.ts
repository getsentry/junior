/** Run-scoped skill discovery and explicit invocation. */
import type { AgentRun } from "@/chat/agent/types";
import type { Actor } from "@sentry/junior-plugin-api";
import { dispatchInstructionsInvokeSkills } from "@/chat/conversations/kind-behavior";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { logInfo } from "@/chat/logging";
import { discoverSkills, type SkillMetadata } from "@/chat/skills";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import type { PiMessage } from "@/chat/pi/messages";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { readTaskInstructions } from "@/chat/task-input";

let startupDiscoveryLogged = false;

/**
 * Return the skills that the model can load with `loadSkill`. A manual-only
 * skill is loadable only when the Turn's message invokes it, or when a
 * loadable skill references it as `$name` in its SKILL.md instructions. The
 * model can load any loadable skill at any time, so the list is fixed for the
 * Turn. No other text, such as memory, thread messages, or tool results,
 * unlocks one.
 */
export function loadableSkills(
  availableSkills: SkillMetadata[],
  invokedSkillNames: readonly string[],
): SkillMetadata[] {
  const byName = new Map(availableSkills.map((skill) => [skill.name, skill]));
  const unlocked = new Set<string>();
  const pending = [
    ...invokedSkillNames,
    ...availableSkills
      .filter((skill) => skill.disableModelInvocation !== true)
      .map((skill) => skill.name),
  ];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const skill = byName.get(name);
    if (!skill || unlocked.has(name)) {
      continue;
    }
    unlocked.add(name);
    pending.push(...(skill.references ?? []));
  }
  return availableSkills.filter((skill) => unlocked.has(skill.name));
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

function lastLoadedSkillName(messages: readonly PiMessage[]): string | null {
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
  return null;
}

/**
 * Make the last skill that `loadSkill` loaded earlier in this Turn active
 * again in a resumed slice, so its tool limits and files still apply. Skills
 * from earlier Turns are never restored.
 */
export async function restoreActiveSkill(args: {
  currentTurnMessages: readonly PiMessage[];
  resumed: boolean;
  skillSandbox: SkillSandbox;
}): Promise<void> {
  if (!args.resumed) {
    return;
  }
  const skillName = lastLoadedSkillName(args.currentTurnMessages);
  if (skillName) {
    await args.skillSandbox.loadSkill(skillName);
  }
}
