/**
 * The web links of Inbox item subjects. A question has none: its related
 * links show on its card, but they do not decide it. A subject whose id
 * is a web URL is its own link. A plugin kind that names a code change (`codeChange`) has
 * the code change's provider id, so its link comes from the code change
 * records, which follow a renamed or moved repository. The item stores no
 * link.
 */
import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { and, eq, inArray } from "drizzle-orm";
import { codeChangeUrl } from "@/chat/code/links";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import type { JuniorDatabase } from "@/db/db";
import { juniorCodeChanges, juniorCodeRepositories } from "@/db/schema";
import {
  pluginSubjectKind,
  subjectKindPlugin,
  subjectLink,
  type InboxItemLinkSource,
  type InboxItemSubject,
} from "./subjects";

/** The key of one subject in a map. */
export function subjectKey(subject: InboxItemSubject): string {
  return `${subject.kind}\n${subject.id}`;
}

/**
 * Return the provider of a subject kind whose id is a code change's
 * provider id: the plugin that registered the kind with `codeChange`.
 */
export function codeChangeSubjectProvider(
  kind: string,
  plugins: readonly PluginRegistration[] = getPlugins(),
): string | undefined {
  const plugin = subjectKindPlugin(kind);
  if (!plugin) return undefined;
  const own = kind.slice(plugin.length + 1);
  const registered = plugins
    .find((registration) => registration.manifest.name === plugin)
    ?.inboxSubjects?.find((subject) => subject.kind === own);
  return registered?.codeChange ? plugin : undefined;
}

/**
 * Return the subject kinds whose ids are code change provider ids, such as
 * `github:pull_request`.
 */
export function codeChangeSubjectKinds(
  plugins: readonly PluginRegistration[] = getPlugins(),
): string[] {
  return plugins.flatMap((plugin) =>
    (plugin.inboxSubjects ?? []).flatMap((subject) =>
      subject.codeChange
        ? [pluginSubjectKind(plugin.manifest.name, subject.kind)]
        : [],
    ),
  );
}

/**
 * Read the link of each item's subject that has one, by `subjectKey`. One
 * query reads the code changes of every code change kind.
 */
export async function readSubjectLinks(
  db: JuniorDatabase,
  items: readonly InboxItemLinkSource[],
  plugins: readonly PluginRegistration[] = getPlugins(),
): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  const changes: Array<{ provider: string; subject: InboxItemSubject }> = [];
  for (const item of items) {
    const { subject } = item;
    const provider = codeChangeSubjectProvider(subject.kind, plugins);
    if (provider) {
      changes.push({ provider, subject });
      continue;
    }
    const url = subjectLink(subject);
    if (url) links.set(subjectKey(subject), url);
  }
  if (changes.length === 0) return links;
  const rows = await db
    .select({
      number: juniorCodeChanges.number,
      provider: juniorCodeChanges.provider,
      providerId: juniorCodeChanges.providerId,
      repository: juniorCodeRepositories.name,
    })
    .from(juniorCodeChanges)
    .innerJoin(
      juniorCodeRepositories,
      eq(juniorCodeRepositories.id, juniorCodeChanges.repositoryId),
    )
    .where(
      and(
        inArray(juniorCodeChanges.provider, [
          ...new Set(changes.map((change) => change.provider)),
        ]),
        inArray(juniorCodeChanges.providerId, [
          ...new Set(changes.map((change) => change.subject.id)),
        ]),
      ),
    );
  const urls = new Map(
    rows.flatMap((row) => {
      const url = codeChangeUrl(row);
      return url ? [[`${row.provider}\n${row.providerId}`, url] as const] : [];
    }),
  );
  for (const { provider, subject } of changes) {
    // A legacy item whose code change Junior could not find kept its URL.
    const url = urls.get(`${provider}\n${subject.id}`) ?? subjectLink(subject);
    if (url) links.set(subjectKey(subject), url);
  }
  return links;
}
