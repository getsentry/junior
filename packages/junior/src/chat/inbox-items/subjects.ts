/**
 * The subject of an Inbox item: what it is about, as a `{ kind, id }` pair.
 * The kind says what the item asks and who changes it. A plugin kind starts
 * with the plugin name, such as `github:pull_request_review`. The core kinds
 * are below. The item stores only the pair. Its title, state, and link come
 * from the subject when Junior shows it (`resolve-subjects.ts`).
 */
import type {
  ObjectAnnotation,
  PluginRegistration,
} from "@sentry/junior-plugin-api";

/** What an Inbox item is about. */
export interface InboxItemSubject {
  /**
   * The object, such as the canonical URL of a pull request, a To-do, or an
   * Automation. Search matches it exactly.
   */
  id: string;
  kind: string;
}

/**
 * The core subject kinds:
 * - `agent`: an agent's question or notice. The id is the one the agent
 *   gave, such as a pull request URL, or else the item's dedupe key.
 * - `automation`: an Automation alert. The id is the Automation.
 * - `reply`: a reply notice. The id is the Conversation.
 * - `todo`: a To-do for a person. The id is `<conversationId>:<todoId>`.
 */
export const INBOX_SUBJECT_KINDS = {
  agent: "agent",
  automation: "automation",
  reply: "reply",
  todo: "todo",
} as const;

/** Return the stored kind of a plugin's own kind: `<plugin>:<kind>`. */
export function pluginSubjectKind(plugin: string, kind: string): string {
  return `${plugin}:${kind}`;
}

/** Return the plugin that owns a subject kind, or undefined for core. */
export function subjectKindPlugin(kind: string): string | undefined {
  const split = kind.indexOf(":");
  return split > 0 ? kind.slice(0, split) : undefined;
}

/**
 * Return the link of a subject whose id is a web URL, such as a pull
 * request, for the object link resolvers.
 */
export function subjectLink(subject: InboxItemSubject): string | undefined {
  const url = URL.parse(subject.id);
  return url?.protocol === "https:" || url?.protocol === "http:"
    ? url.href
    : undefined;
}

/**
 * Return the label of a stored plugin kind: the ask that the plugin reads
 * from the object's live card, such as `Ready to merge`, else the label
 * that it registered. Core kinds have none: the Inbox names them itself.
 */
export function subjectKindLabel(
  kind: string,
  plugins: readonly PluginRegistration[],
  object?: ObjectAnnotation,
): string | undefined {
  const plugin = subjectKindPlugin(kind);
  if (!plugin) return undefined;
  const own = kind.slice(plugin.length + 1);
  const registered = plugins
    .find((registration) => registration.manifest.name === plugin)
    ?.inboxSubjects?.find((subject) => subject.kind === own);
  return (object && registered?.ask?.(object)) ?? registered?.label;
}

/**
 * Return the To-do of an item's subject, or undefined for another kind. A
 * Conversation id can hold colons, so the To-do id is after the last one.
 */
export function subjectTodo(
  subject: InboxItemSubject,
): { conversationId: string; id: number } | undefined {
  if (subject.kind !== INBOX_SUBJECT_KINDS.todo) return undefined;
  const split = subject.id.lastIndexOf(":");
  const id = Number(subject.id.slice(split + 1));
  if (split <= 0 || !Number.isSafeInteger(id) || id <= 0) return undefined;
  return { conversationId: subject.id.slice(0, split), id };
}
