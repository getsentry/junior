import {
  objectAnnotationSchema,
  type OwnedObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";

/** Save object annotations and retain returned facts in the tool result. */
export async function saveObjectAnnotations(
  conversationId: string,
  plugin: string,
  value: unknown,
): Promise<OwnedObjectAnnotation[]> {
  const annotations = objectAnnotationSchema.array().parse(value);
  await getDb().transaction(async (db) => {
    const store = createPluginAnnotations({ conversationId, plugin, db });
    /* oxlint-disable no-await-in-loop -- Writes share one transaction. */
    for (const annotation of annotations) {
      await store.upsert(annotation);
      // Replace a legacy link for the same object without changing other annotations.
      await store.remove("resource_link", annotation.key);
    }
    /* oxlint-enable no-await-in-loop */
  });
  return annotations.map((annotation) => ({ ...annotation, plugin }));
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
