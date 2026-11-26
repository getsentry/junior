/**
 * The system prompt guidance of To-dos, which the To-do registration adds
 * through its `systemPrompt` hook. It says what goes on the durable To-dos:
 * only work that outlives the Turn. It is not a per-Turn checklist. How to
 * call `todos_updateTodos` goes in its description.
 */
import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { TODOS_REGISTRATION_NAME, UPDATE_TODOS_TOOL_NAME } from "./types";

const TOOL = `\`${UPDATE_TODOS_TOOL_NAME}\``;

// The To-do rules. A Lead has no To-do tool, so they name it.
const TODOS_SYSTEM_PROMPT = [
  `These rules hold when ${TOOL} is one of your tools.`,
  `- Use ${TOOL} only for work that outlives this Turn: work you queue for a later Turn, work you hand to a child agent, with that child as assignee, and work assigned to a person. Do not add steps that you finish in this Turn, however many there are.`,
  "- Your To-dos are your only durable backlog. Compaction drops details from history, and sandbox files can disappear, so never keep a backlog in a file.",
  `- Set a To-do to in_progress when its work starts, and to done or dropped in the Turn that its work ends, such as when its pull request merges, or when a child agent's result says the work is finished, not only that its Turn ended. The \`todos\` plugin contribution lists the open To-dos after a compaction, or when your To-dos have not changed for a few Turns, and shows To-dos that people or child agents changed since you last saw them. Archiving a child agent closes its open To-dos as done, and stopping it drops them.`,
  "- Do not repeat your To-dos in chat, and do not end a Turn with a list of next steps when you can do the work now.",
  `- To-do ids such as \`TODO-12\` are only for ${TOOL}. Do not write them in a reply, a PR, an issue, or a message to a person. Name the work instead.`,
  `- In a Turn with a person's input, when your reply leaves a task that only a person in this Conversation can do, the item it carries is a To-do assigned to them with ${TOOL}.`,
  `- As a child agent: the parent entry of \`listAgents\` shows the parent's open To-dos. When the work of one assigned to you (assignee self) ends, set it to done or dropped with ${TOOL}. Only the parent changes its other To-dos. The rest close when your parent archives you (done) or stops you (dropped).`,
].join("\n");

/**
 * The prompt-only part of the To-do registration. A build renders system
 * prompts from it, so this module imports no runtime code.
 */
export const todosSystemPromptRegistration = {
  manifest: {
    name: TODOS_REGISTRATION_NAME,
    displayName: "To-dos",
    description: "Durable work that outlives a Turn",
  },
  hooks: {
    systemPrompt: () => [{ text: TODOS_SYSTEM_PROMPT }],
  },
} satisfies PluginRegistration;
