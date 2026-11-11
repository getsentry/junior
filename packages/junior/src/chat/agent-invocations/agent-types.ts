import * as z from "zod";

/**
 * Child agent types. A type is plain data: when to pick it and what the child
 * reads with its task. Runtime code reads only these fields, never a type
 * name, so types can later come from configuration. Types do not limit tools:
 * Guardian reviews each child action against the root user's messages, as for
 * any child. A child keeps its type for later agent invocations. How a child
 * starts, fresh or forked from its parent's history, is not a type: see
 * `fork` on the agent invocation.
 */
export const AGENT_TYPES = ["explore", "reviewer"] as const;

/**
 * Stored name of a child agent type. A stored name stays readable after its
 * type is removed; the runtime then treats the child as a
 * child without a type.
 */
export const agentTypeSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);

/** Name of one child agent type. */
export type AgentType = z.output<typeof agentTypeSchema>;

type AgentTypeDefinition = {
  /** Model-facing guidance on when the parent should pick this type. */
  whenToUse: string;
  /** Instructions that the child reads with each task. */
  instructions: string;
};

const AGENT_TYPE_DEFINITIONS: Record<
  (typeof AGENT_TYPES)[number],
  AgentTypeDefinition
> = {
  explore: {
    whenToUse:
      "Investigation across code, docs, logs, telemetry, or the web. Use it when an answer needs reading across many files or sources and you need the conclusion with evidence, not the raw output.",
    instructions:
      "You are an explore agent. Your job is to investigate and report, so do not change anything outside your sandbox unless the task asks for it. Report what you found with exact evidence, such as paths, lines, links, and ids, and say what you could not verify.",
  },
  reviewer: {
    whenToUse:
      "An independent second opinion on a change, plan, or claim. Give it the evidence to judge, not your conclusion.",
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

/** Model-facing list of child agent types. */
export function formatAgentTypes(): string {
  return AGENT_TYPES.map(
    (type) => `- "${type}": ${AGENT_TYPE_DEFINITIONS[type].whenToUse}`,
  ).join("\n");
}

/** Return the instructions that a child of this type reads with its task. */
export function agentTypeInstructions(
  type: AgentType | undefined,
): string | undefined {
  return agentTypeDefinition(type)?.instructions;
}
