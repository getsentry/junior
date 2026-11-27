import {
  annotatedObjectSchema,
  type AnnotatedObject,
  type OwnedObjectAnnotation,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { loadAnnotationLabeler } from "@/chat/conversations/annotation-labels";
import { getDb } from "@/chat/db";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import {
  ANNOTATION_SUBJECT_KINDS,
  CORE_ANNOTATION_PLUGIN,
  createPluginAnnotations,
  upsertPluginAnnotation,
} from "@/chat/plugins/annotations";

// A plugin names its objects with the subject kinds that it registers for
// the Inbox, so an Annotation and an Inbox item about one object match.
function assertSubjectKind(
  plugin: string,
  annotation: AnnotatedObject,
  plugins: readonly PluginRegistration[],
): void {
  const kind = annotation.subject?.kind;
  if (kind === undefined) return;
  const known =
    plugin === CORE_ANNOTATION_PLUGIN
      ? Object.values<string>(ANNOTATION_SUBJECT_KINDS).includes(kind)
      : plugins.some(
          (registration) =>
            registration.manifest.name === plugin &&
            registration.inboxSubjects?.some(
              (subject) => subject.kind === kind,
            ),
        );
  if (!known) {
    throw new Error(
      `${plugin} returned an object Annotation with subject kind "${kind}", which it does not register in inboxSubjects.`,
    );
  }
}

/**
 * Save object annotations, and return each object with the label that its
 * plugin makes, for the tool result and its Message cards.
 */
export async function saveObjectAnnotations(
  conversationId: string,
  plugin: string,
  value: unknown,
): Promise<OwnedObjectAnnotation[]> {
  const annotations = annotatedObjectSchema.array().parse(value);
  const plugins = getPlugins();
  for (const annotation of annotations) {
    assertSubjectKind(plugin, annotation, plugins);
  }
  await getDb().transaction(async (db) => {
    const store = createPluginAnnotations({ conversationId, plugin, db });
    /* oxlint-disable no-await-in-loop -- Writes share one transaction. */
    for (const { action, ...annotation } of annotations) {
      await upsertPluginAnnotation(db, {
        action,
        annotation,
        conversationId,
        plugin,
      });
      // Replace a legacy link for the same object without changing other annotations.
      await store.remove("resource_link", annotation.key);
    }
    /* oxlint-enable no-await-in-loop */
  });
  const label = await loadAnnotationLabeler();
  return annotations.map(({ action: _action, ...annotation }) => ({
    ...annotation,
    label: label({ ...annotation, plugin }),
    plugin,
  }));
}

/**
 * Save annotations from a successful plugin tool result and attach their cards.
 * An Annotation marks work that the Conversation did, so a read-only tool must
 * not return one: looking up an object does not link it.
 */
export async function annotateToolResult(
  conversationId: string,
  plugin: string,
  result: unknown,
  options: { readOnly: boolean },
): Promise<unknown> {
  if (typeof result !== "object" || result === null) return result;
  if ("isError" in result && result.isError === true) return result;
  const details =
    "details" in result &&
    typeof result.details === "object" &&
    result.details !== null
      ? result.details
      : result;
  if (
    ("timed_out" in details && details.timed_out === true) ||
    ("isError" in details && details.isError === true) ||
    !("objectAnnotations" in details) ||
    !Array.isArray(details.objectAnnotations)
  )
    return result;
  if (options.readOnly) {
    throw new Error(
      `Read-only ${plugin} tool returned objectAnnotations. Return them only from tools that change the object.`,
    );
  }
  const cards = await saveObjectAnnotations(
    conversationId,
    plugin,
    details.objectAnnotations,
  );
  const { objectAnnotations: _annotations, ...rest } = details;
  const annotated = { ...rest, objectCards: cards };
  if (details !== result) return { ...result, details: annotated };
  return annotated;
}
