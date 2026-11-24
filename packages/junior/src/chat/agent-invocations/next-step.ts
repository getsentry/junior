/**
 * `next_step` text of the agent tools. Each text is built from stored state:
 * a fact that the model could not see before the call, and the next step.
 * Results of child agents arrive by themselves, so the text tells the agent
 * to wait for them instead of checking again.
 */
import type { ChildAgentRef } from "./types";

/** Name of a child agent in model-read text, the same as in `waiting_on`. */
export function childAgentDisplayName(agent: ChildAgentRef): string {
  return agent.agentName ?? agent.title ?? agent.childConversationId;
}

/**
 * One sentence that names the child agents that still work and says that
 * their results arrive as new tasks. Undefined when none works.
 */
export function waitForChildAgentsStep(
  working: readonly ChildAgentRef[],
): string | undefined {
  if (working.length === 0) {
    return undefined;
  }
  const names = working
    .map((agent) => `"${childAgentDisplayName(agent)}"`)
    .join(", ");
  return working.length === 1
    ? `Child agent ${names} still works, and its result arrives as a new task, so do other work or end this turn instead of checking on it.`
    : `Child agents ${names} still work, and each result arrives as a new task, so do other work or end this turn instead of checking on them.`;
}
