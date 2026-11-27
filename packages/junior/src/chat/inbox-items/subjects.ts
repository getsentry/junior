/**
 * The subject of an Inbox item: what it is about, as a `{ kind, id }` pair.
 * The kind says what the item asks and who changes it. A plugin kind starts
 * with the plugin name, such as `github:pull_request`. The core kinds
 * are below. The item stores only the pair. Its title, state, and link come
 * from the subject when Junior shows it (`resolve-subjects.ts`).
 */
import type {
  ObjectAnnotation,
  PluginInboxKindAction,
  PluginInboxSubjectKind,
  PluginInboxViewer,
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
 *   is the question (`junior_questions`), so it names only that item. What
 *   a question is about comes from its related links.
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

/** An item as its link reads it: its subject. */
export interface InboxItemLinkSource {
  subject: InboxItemSubject;
}

/**
 * Return the http(s) links of a question's related links, such as a pull
 * request that it is about. They do not decide its card. Other kinds
 * return none.
 */
export function questionLinks(item: {
  request?: { related?: ReadonlyArray<{ url?: string }> } | null | undefined;
  subject: InboxItemSubject;
}): string[] {
  if (item.subject.kind !== INBOX_SUBJECT_KINDS.question) return [];
  const links = (item.request?.related ?? []).flatMap((entry) => {
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

// The registered plugin kind of a stored kind, and the viewer's handle on
// that plugin's provider. A plugin's provider Identities carry its name,
// such as `github`.
function registeredSubjectKind(
  kind: string,
  plugins: readonly PluginRegistration[],
  viewer: User | undefined,
): { registered?: PluginInboxSubjectKind; viewer: PluginInboxViewer } {
  const plugin = subjectKindPlugin(kind);
  if (!plugin) return { viewer: {} };
  const own = kind.slice(plugin.length + 1);
  const registered = plugins
    .find((registration) => registration.manifest.name === plugin)
    ?.inboxSubjects?.find((subject) => subject.kind === own);
  const handle = viewer?.identities.find(
    (identity) => identity.provider === plugin,
  )?.handle;
  return { registered, viewer: handle ? { handle } : {} };
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
  const { registered, viewer: reader } = registeredSubjectKind(
    kind,
    plugins,
    viewer,
  );
  return (object && registered?.ask?.(object, reader)) ?? registered?.label;
}

/**
 * Return what else the viewer's dismiss of a stored plugin kind changes on
 * the provider, or undefined when it changes nothing there.
 */
export function subjectKindDismissNote(
  kind: string,
  plugins: readonly PluginRegistration[],
  object: ObjectAnnotation | undefined,
  viewer: User,
): string | undefined {
  const { registered, viewer: reader } = registeredSubjectKind(
    kind,
    plugins,
    viewer,
  );
  return registered?.dismissNote?.(object, reader);
}

/**
 * Return the actions that a plugin kind puts on its open items, such as
 * Resume. Core kinds have none here: a To-do closes with Mark done.
 */
export function subjectKindActions(
  kind: string,
  plugins: readonly PluginRegistration[],
): readonly PluginInboxKindAction[] {
  return (
    registeredSubjectKind(kind, plugins, undefined).registered?.actions ?? []
  );
}

/** Return the label of a kind action by its id, such as Resume. */
export function subjectKindActionLabel(
  kind: string,
  plugins: readonly PluginRegistration[],
  id: string | undefined,
): string | undefined {
  return subjectKindActions(kind, plugins).find((action) => action.id === id)
    ?.label;
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
