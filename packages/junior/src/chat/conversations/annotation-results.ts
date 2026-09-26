import {
  objectAnnotationSchema,
  type OwnedObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { isRecord } from "@/chat/coerce";
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
    for (const annotation of annotations) {
      await store.upsert(annotation);
      // Replace a legacy link for the same object without changing other annotations.
      await store.remove("resource_link", annotation.key);
    }
  });
  return annotations.map((annotation) => ({ ...annotation, plugin }));
}

/** Save annotations from a successful plugin tool result and attach their cards. */
export async function annotateToolResult(
  conversationId: string,
  plugin: string,
  result: unknown,
): Promise<unknown> {
  if (!isRecord(result) || result.isError === true) return result;
  const details = isRecord(result.details) ? result.details : result;
  if (
    details.timed_out === true ||
    details.isError === true ||
    !Array.isArray(details.objectAnnotations)
  )
    return result;
  const cards = await saveObjectAnnotations(
    conversationId,
    plugin,
    details.objectAnnotations,
  );
  const { objectAnnotations: _annotations, ...rest } = details;
  const annotated = { ...rest, objectCards: cards };
  if (isRecord(result.details)) return { ...result, details: annotated };
  return annotated;
}
