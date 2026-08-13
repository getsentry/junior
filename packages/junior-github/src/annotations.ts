import type { ConversationAnnotationInput } from "@sentry/junior-plugin-api";
type ResourceLinkAnnotation = Extract<
  ConversationAnnotationInput,
  { kind: "resource_link" }
>;

/** Return GitHub repository grouping for a conversation sidebar annotation. */
export function githubRepositorySidebar(
  repositoryFullName: string,
): NonNullable<ResourceLinkAnnotation["sidebar"]> {
  const label = repositoryFullName.split("/").at(-1)?.trim();
  if (!label) throw new Error("GitHub repository name is required.");
  return {
    group: "github-repositories",
    label,
    pluralLabel: "repos",
  };
}
