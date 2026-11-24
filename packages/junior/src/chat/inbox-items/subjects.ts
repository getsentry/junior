/**
 * The subject of an Inbox item: what it is about, as a `{ kind, id }` pair.
 * The kind says what the item asks and who changes it. A plugin kind starts
 * with the plugin name, such as `github:pull_request`. The core kinds
 * are below. The item stores only the pair. Its title, state, and link come
 * from the subject when Junior shows it (`resolve-subjects.ts`).
 */
import type {
  ObjectAnnotation,
  PluginRegistration,
  User,
} from "@sentry/junior-plugin-api";

/** What an Inbox item is about. */
export interface InboxItemSubject {
  /**
   * The object, such as a pull request, a To-do, or an Automation, or a
   * question's key. Search matches it exactly.
   */
  id: string;
  kind: string;
}

/**
 * The core subject kinds:
 * - `question`: an item that an agent adds, a question or a notice. The id
 *   is the agent's key, or a new id for an item without a key, so it names
 *   only that item. What a question is about comes from its evidence.
 * - `automation`: an Automation alert. The id is the Automation.
 * - `reply`: a reply notice. The id is the Conversation.
 * - `todo`: a To-do for a person. The id is `<conversationId>:<todoId>`.
 */
export const INBOX_SUBJECT_KINDS = {
  automation: "automation",
  question: "question",
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
 * An item as its link and related work read it: its subject, and the
 * request whose evidence says what a question is about.
 */
export interface InboxItemLinkSource {
  request?: { evidence?: ReadonlyArray<{ url?: string }> } | null | undefined;
  subject: InboxItemSubject;
}

/**
 * Return what an agent's question or notice is about: the http(s) links of
 * its evidence, such as a pull request. Its key is no link. Other kinds
 * return none.
 */
export function questionLinks(item: InboxItemLinkSource): string[] {
  if (item.subject.kind !== INBOX_SUBJECT_KINDS.question) return [];
  const links = (item.request?.evidence ?? []).flatMap((entry) => {
    const url = entry.url ? webLink(entry.url) : undefined;
    return url ? [url] : [];
  });
  return [...new Set(links)];
}

// A link keeps its stored text, so it matches the same text in SQL.
function webLink(value: string): string | undefined {
  const url = URL.parse(value);
  return url?.protocol === "https:" || url?.protocol === "http:"
    ? value
    : undefined;
}

/**
 * Return the link of a subject whose id is a web URL, such as a pull
 * request, for the object link resolvers.
 */
export function subjectLink(subject: InboxItemSubject): string | undefined {
  return webLink(subject.id);
}

/**
 * Return the label of a stored plugin kind: the ask of the viewer that the
 * plugin reads from the object's live card, such as `Ready to merge` for
 * the author and `Review requested` for a reviewer, else the label that it
 * registered. Core kinds have none: the Inbox names them itself.
 */
export function subjectKindLabel(
  kind: string,
  plugins: readonly PluginRegistration[],
  object?: ObjectAnnotation,
  viewer?: User,
): string | undefined {
  const plugin = subjectKindPlugin(kind);
  if (!plugin) return undefined;
  const own = kind.slice(plugin.length + 1);
  const registered = plugins
    .find((registration) => registration.manifest.name === plugin)
    ?.inboxSubjects?.find((subject) => subject.kind === own);
  // A plugin's provider Identities carry its name, such as `github`.
  const handle = viewer?.identities.find(
    (identity) => identity.provider === plugin,
  )?.handle;
  return (
    (object && registered?.ask?.(object, handle ? { handle } : {})) ??
    registered?.label
  );
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
