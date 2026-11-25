import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { findObjectLinkType } from "@/api/objects/link-types";
import { codeChangeSubjectKinds } from "@/chat/inbox-items/subject-links";
import {
  subjectKindPlugin,
  type InboxItemSubject,
} from "@/chat/inbox-items/subjects";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorCodeChanges,
  juniorCodeRepositories,
  juniorConversationAnnotations,
  juniorConversations,
} from "@/db/schema";

const annotations = juniorConversationAnnotations;

/** The title that an Annotation stores for search. */
export const storedAnnotationTitle = sql<
  string | null
>`${annotations.annotation}->>'title'`;

/** The link that an Annotation stores for search. */
export const storedAnnotationUrl = sql<
  string | null
>`${annotations.annotation}->>'url'`;

/**
 * Which Annotations a filter matches:
 * - `references`: keys or links in lower case, such as `owner/repo#12`. A
 *   key also matches its nested children that continue with `#`, so
 *   `owner/repo` matches each object of the repository.
 * - `subjects`: objects by their stored subject, which a rename keeps.
 */
export interface AnnotationFilter {
  references: readonly string[];
  subjects: readonly InboxItemSubject[];
}

// `<repository>#<number>`, as a code change shows in the composer. The
// number fits the integer column.
const CODE_CHANGE_REFERENCE = /^(\S+)#(\d{1,9})$/;

interface CodeChangeReference {
  number: number;
  /** Only the code changes of this plugin, for a link that it claims. */
  provider?: string;
  repository: string;
}

function codeChangeReference(
  text: string,
  provider?: string,
): CodeChangeReference | undefined {
  const match = CODE_CHANGE_REFERENCE.exec(text);
  if (!match?.[1] || !match[2]) return undefined;
  return {
    number: Number(match[2]),
    ...(provider ? { provider } : undefined),
    repository: match[1],
  };
}

// The plugin link type that claims a link names its object from the link
// alone, such as `owner/repo#12` for a pull request link.
function linkLabel(
  text: string,
  plugins: readonly PluginRegistration[],
): { label: string; provider: string } | undefined {
  const url = URL.parse(text);
  if (!url) return undefined;
  const linkTypes = plugins.flatMap((plugin) =>
    (plugin.objectLinks ?? []).map((link) => ({
      filters: link.filters,
      label: link.label,
      provider: plugin.manifest.name,
    })),
  );
  const linkType = findObjectLinkType(linkTypes, url);
  const label = linkType?.label?.(url)?.toLowerCase();
  return linkType && label ? { label, provider: linkType.provider } : undefined;
}

// The subjects of the code changes that the references name, by the
// current name of their repository.
async function readCodeChangeSubjects(
  db: JuniorDatabase,
  references: readonly CodeChangeReference[],
  plugins: readonly PluginRegistration[],
): Promise<InboxItemSubject[]> {
  const kinds = codeChangeSubjectKinds(plugins);
  if (references.length === 0 || kinds.length === 0) return [];
  const providers = [
    ...new Set(kinds.flatMap((kind) => subjectKindPlugin(kind) ?? [])),
  ];
  const rows = await db
    .select({
      provider: juniorCodeChanges.provider,
      providerId: juniorCodeChanges.providerId,
    })
    .from(juniorCodeChanges)
    .innerJoin(
      juniorCodeRepositories,
      eq(juniorCodeRepositories.id, juniorCodeChanges.repositoryId),
    )
    .where(
      and(
        inArray(juniorCodeChanges.provider, providers),
        or(
          ...references.map((reference) =>
            and(
              sql`lower(${juniorCodeRepositories.name}) = ${reference.repository}`,
              eq(juniorCodeChanges.number, reference.number),
              reference.provider
                ? eq(juniorCodeChanges.provider, reference.provider)
                : undefined,
            ),
          ),
        ),
      ),
    );
  return rows.flatMap((row) =>
    kinds
      .filter((kind) => subjectKindPlugin(kind) === row.provider)
      .map((kind) => ({ id: row.providerId, kind })),
  );
}

/**
 * Resolve text that names an object, such as `owner/repo#12` or its link,
 * to an Annotation filter, without a provider call. The plugin that claims
 * a link names the object from the link. A `<repository>#<number>`
 * reference names a code change, which the code change records find by the
 * repository's current name. So an object of a renamed repository still
 * matches by its subject.
 */
export async function resolveAnnotationFilter(
  db: JuniorDatabase,
  text: string,
  plugins: readonly PluginRegistration[] = getPlugins(),
): Promise<AnnotationFilter> {
  const reference = text.trim().toLowerCase();
  const link = linkLabel(text.trim(), plugins);
  const changes = [
    codeChangeReference(reference),
    link ? codeChangeReference(link.label, link.provider) : undefined,
  ].flatMap((change) => change ?? []);
  return {
    references: link ? [reference, link.label] : [reference],
    subjects: await readCodeChangeSubjects(db, changes, plugins),
  };
}

/** Match the Annotation rows that the filter names. */
export function annotationMatches(filter: AnnotationFilter): SQL {
  const key = sql`lower(${annotations.key})`;
  return (
    or(
      ...filter.references.map(
        (reference) =>
          sql`(${key} = ${reference} or starts_with(${key}, ${`${reference}#`}) or lower(${storedAnnotationUrl}) = ${reference})`,
      ),
      ...filter.subjects.map((subject) =>
        and(
          eq(annotations.subjectKind, subject.kind),
          eq(annotations.subjectId, subject.id),
        ),
      ),
    ) ?? sql`false`
  );
}

/** Match Conversations that have an Annotation that the filter names. */
export function hasMatchingAnnotation(
  conversationId: AnyPgColumn,
  filter: AnnotationFilter,
): SQL {
  return sql`exists (
    select 1
    from ${annotations}
    where ${and(
      eq(annotations.conversationId, conversationId),
      annotationMatches(filter),
    )}
  )`;
}

const ANNOTATED_ALIAS = "annotated_conversations";

/**
 * Match root Conversations where any Conversation in the tree has an
 * Annotation that the filter names. Tools write the Annotation on the
 * Conversation that ran them, which can be a child agent.
 */
export function treeHasMatchingAnnotation(
  rootConversationId: AnyPgColumn,
  filter: AnnotationFilter,
): SQL {
  // An alias, so the outer query's Conversation columns are not shadowed.
  const annotated = alias(juniorConversations, ANNOTATED_ALIAS);
  return sql`exists (
    select 1
    from ${annotations}
    inner join ${juniorConversations} as ${sql.identifier(ANNOTATED_ALIAS)}
      on ${annotated.conversationId} = ${annotations.conversationId}
    where ${and(
      eq(annotated.rootConversationId, rootConversationId),
      annotationMatches(filter),
    )}
  )`;
}
