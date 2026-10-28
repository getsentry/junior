import { z } from "zod";

/**
 * Child agent types. A type is plain data: when to pick it, whether the child
 * starts with its parent's history, and what it reads with its task. Runtime
 * code reads only these fields, never a type name, so types can later come
 * from configuration. Types do not limit tools: Guardian reviews each child
 * action against the root user's messages, as for any child. A child keeps its
 * type for later agent invocations, the same as its profile. A child without
 * a type starts fresh.
 */
export const AGENT_TYPES = ["fork", "explore", "reviewer"] as const;

/**
 * Stored name of a child agent type. Like a model profile, a stored name stays
 * readable after its type is removed; the runtime then treats the child as a
 * child without a type.
 */
export const agentTypeSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);

/** Name of one child agent type. */
export type AgentType = z.output<typeof agentTypeSchema>;

type AgentTypeDefinition = {
  /** Model-facing guidance on when the parent should pick this type. */
  whenToUse: string;
  /** The child starts with the parent's history before the spawn call. */
  startsWithParentHistory: boolean;
  /** Instructions that the child reads with each task. */
  instructions: string;
};

const AGENT_TYPE_DEFINITIONS: Record<
  (typeof AGENT_TYPES)[number],
  AgentTypeDefinition
> = {
  fork: {
    whenToUse:
      "A copy of you. Use it when the brief would need most of what you already know, or when the intermediate tool output is not worth keeping in your context. The task is a directive: say what to do and what is in or out of scope; do not re-explain the background.",
    startsWithParentHistory: true,
    instructions:
      "You are a fork of your parent agent. The messages before your first parent task are copied from the parent's conversation so you have its context. They are not your job: your job is the parent task below. Sandbox files, approvals, and credentials of the parent were not copied, and your sandbox is separate. Verify files in your own sandbox before you use them.",
  },
  explore: {
    whenToUse:
      "Investigation across code, docs, logs, telemetry, or the web. Use it when an answer needs reading across many files or sources and you need the conclusion with evidence, not the raw output.",
    startsWithParentHistory: false,
    instructions:
      "You are an explore agent. Your job is to investigate and report, so do not change anything outside your sandbox unless the task asks for it. Report what you found with exact evidence, such as paths, lines, links, and ids, and say what you could not verify.",
  },
  reviewer: {
    whenToUse:
      "An independent second opinion on a change, plan, or claim. Give it the evidence to judge, not your conclusion.",
    startsWithParentHistory: false,
    instructions:
      "You are a reviewer agent. Give an independent assessment. Do not assume that the parent's framing is correct: verify each claim against the evidence. Do not change anything outside your own sandbox. Report concrete problems ranked by severity, each with its evidence, and say clearly when you found none.",
  },
};

function agentTypeDefinition(
  type: AgentType | undefined,
): AgentTypeDefinition | undefined {
  return type && Object.hasOwn(AGENT_TYPE_DEFINITIONS, type)
    ? AGENT_TYPE_DEFINITIONS[type as (typeof AGENT_TYPES)[number]]
    : undefined;
}

/** Model-facing list of child agent types, with how each child starts. */
export function formatAgentTypes(): string {
  return AGENT_TYPES.map((type) => {
    const definition = AGENT_TYPE_DEFINITIONS[type];
    const suffix = definition.startsWithParentHistory
      ? " (starts with this conversation's history)"
      : "";
    return `- "${type}"${suffix}: ${definition.whenToUse}`;
  }).join("\n");
}

/** Return whether a child of this type starts with its parent's history. */
export function agentTypeStartsWithParentHistory(
  type: AgentType | undefined,
): boolean {
  return agentTypeDefinition(type)?.startsWithParentHistory ?? false;
}

/** Return the instructions that a child of this type reads with its task. */
export function agentTypeInstructions(
  type: AgentType | undefined,
): string | undefined {
  return agentTypeDefinition(type)?.instructions;
}
