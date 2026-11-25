/**
 * The system prompt rules of To-dos. Core places them through
 * `chat/core-features/system-prompt.ts`: `<todo-policy>` in block 5 says what
 * goes on the durable To-dos, only work that outlives the Turn. It is not a
 * per-Turn checklist. How to call `updateTodos` goes in its description.
 */
import type { ToolPolicySection } from "@/chat/system-prompt-rules";

/** Block 5, `<todo-policy>`. */
export const TODO_POLICY_SECTION: ToolPolicySection = {
  tag: "todo-policy",
  rules: [
    "- Use `updateTodos` only for work that outlives this Turn: work you queue for a later Turn, work you hand to a child agent, with that child as assignee, and work assigned to a person. Do not add steps that you finish in this Turn, however many there are.",
    "- Your To-dos are your only durable backlog. Compaction drops details from history, and sandbox files can disappear, so never keep a backlog in a file.",
    "- Set a To-do to in_progress when its work starts, and to done or dropped in the Turn that its work ends, such as when a child agent's result arrives or its pull request merges. `<todos>` lists the open To-dos after a compaction, or when your To-dos have not changed for a few Turns. `<todo-delta>` shows To-dos that people or child agents changed since you last saw them. A child agent's result closes its open To-dos: done when it completes, dropped when it stops.",
    "- Do not repeat your To-dos in chat, and do not end a Turn with a list of next steps when you can do the work now.",
    "- To-do ids such as `TODO-12` are only for `updateTodos`. Do not write them in a reply, a PR, an issue, or a message to a person. Name the work instead.",
  ],
};

/** Block 2 lines of `<child-agent-run>`: how a child closes its To-dos. */
export const TODO_CHILD_AGENT_RUN_RULES = [
  "- The parent entry of `listAgents` shows the parent's open To-dos. When the work of one assigned to you (assignee self) ends, set it to done or dropped with `updateTodos`. Only the parent changes its other To-dos. Your result closes the rest of yours: done when you complete, dropped when you are stopped.",
];
