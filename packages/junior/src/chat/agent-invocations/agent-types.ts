/**
 * Child agent types. A type sets how a child starts and what it may do. A
 * child keeps its type for later agent invocations, the same as its profile.
 * A child without a type starts fresh with full tool access.
 */
export const AGENT_TYPES = ["fork", "explore", "reviewer"] as const;

/** One child agent type. */
export type AgentType = (typeof AGENT_TYPES)[number];

type AgentTypeDefinition = {
  /** Model-facing guidance on when the parent should pick this type. */
  whenToUse: string;
  /** The child can use only read-only or sandbox-local tools. */
  readOnly: boolean;
  /** Instructions that the child reads before its first task. */
  instructions: string;
};

const AGENT_TYPE_DEFINITIONS: Record<AgentType, AgentTypeDefinition> = {
  fork: {
    whenToUse:
      "A copy of you that starts with this conversation's history and runs on your profile. Use it when the brief would need most of what you already know, or when the intermediate tool output is not worth keeping in your context. The task is a directive: say what to do and what is in or out of scope; do not re-explain the background.",
    readOnly: false,
    instructions:
      "You are a fork of your parent agent. The earlier messages are copied from the parent's conversation so you have its context. They are not your job: your job is the parent task below. Sandbox files, approvals, and credentials of the parent were not copied, and your sandbox is separate. Verify files in your own sandbox before you use them.",
  },
  explore: {
    whenToUse:
      "Read-only investigation across code, docs, logs, telemetry, or the web. Use it when an answer needs reading across many files or sources and you need the conclusion with evidence, not the raw output.",
    readOnly: true,
    instructions:
      "You are an explore agent. Investigate and report. You can read anything your tools allow and use your own sandbox for scratch work, but do not change anything outside it: no commits, pushes, posts, comments, or other writes. Report what you found with exact evidence, such as paths, lines, links, and ids, and say what you could not verify.",
  },
  reviewer: {
    whenToUse:
      "Read-only, independent second opinion on a change, plan, or claim. Give it the evidence to judge, not your conclusion.",
    readOnly: true,
    instructions:
      "You are a reviewer agent. Give an independent assessment. Do not assume that the parent's framing is correct: verify each claim against the evidence. Do not change anything outside your own sandbox. Report concrete problems ranked by severity, each with its evidence, and say clearly when you found none.",
  },
};

/** Model-facing list of child agent types and when to use each. */
export function formatAgentTypes(): string {
  return AGENT_TYPES.map(
    (type) => `- "${type}": ${AGENT_TYPE_DEFINITIONS[type].whenToUse}`,
  ).join("\n");
}

/** Return whether a child agent of this type has read-only tool access. */
export function isReadOnlyAgentType(type: AgentType | undefined): boolean {
  return type ? AGENT_TYPE_DEFINITIONS[type].readOnly : false;
}

/** Return the instructions that a child of this type reads with its task. */
export function agentTypeInstructions(
  type: AgentType | undefined,
): string | undefined {
  return type ? AGENT_TYPE_DEFINITIONS[type].instructions : undefined;
}
