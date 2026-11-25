import type { ConversationAnnotation } from "@sentry/junior-plugin-api";

/**
 * Load the function that makes the short label of an Annotation from the
 * link type of its plugin. The link types import the app, and the app
 * imports search and the tools that save Annotations, so they load lazily.
 */
export async function loadAnnotationLabeler(): Promise<
  (
    annotation: Pick<
      ConversationAnnotation,
      "key" | "objectType" | "plugin"
    > & {
      url: string | null;
    },
  ) => string
> {
  const [{ annotationLabel }, { readObjectLinkTypes }] = await Promise.all([
    import("@/api/objects/live-annotations"),
    import("@/api/objects/resolve"),
  ]);
  const linkTypes = readObjectLinkTypes();
  return (annotation) => annotationLabel(annotation, linkTypes);
}
