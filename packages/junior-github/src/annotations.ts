import type {
  ConversationAnnotation,
  ConversationSidebarAnnotation,
  ObjectAnnotation,
  PluginAnnotations,
} from "@sentry/junior-plugin-api";

function githubObjectType(
  annotation: ConversationAnnotation,
): "task" | "code_change" {
  if (
    annotation.objectType === "task" ||
    annotation.objectType === "code_change"
  ) {
    return annotation.objectType;
  }
  // Older resource links have no type. Only the provider interprets its URLs.
  return annotation.url &&
    /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/.test(new URL(annotation.url).pathname)
    ? "code_change"
    : "task";
}

function repositoryName(
  annotation: ConversationAnnotation,
): string | undefined {
  try {
    const [, , repo] = new URL(annotation.url ?? "").pathname.split("/");
    return repo || undefined;
  } catch {
    return undefined;
  }
}

/** Return GitHub annotations for a conversation row, newest first. */
export function githubSidebarAnnotations(
  annotations: ConversationAnnotation[],
): ConversationSidebarAnnotation[] {
  return annotations
    .flatMap((annotation) => {
      const status = annotation.status;
      const label = repositoryName(annotation);
      return label
        ? [
            {
              annotation: {
                objectType: githubObjectType(annotation),
                status,
                key: annotation.key,
                label,
              },
              updatedAt: annotation.updatedAt,
            },
          ]
        : [];
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(({ annotation }) => annotation);
}

/** Build the annotation returned by GitHub create and update tools. */
export function githubObjectAnnotation(input: {
  repo: string;
  number: number;
  title: string;
  url: string;
  objectType: "task" | "code_change";
  status: string;
  facts?: ObjectAnnotation["facts"];
  sourceUpdatedAt?: string;
}): ObjectAnnotation {
  return {
    kind: "object",
    key: `${input.repo.toLowerCase()}#${input.number}`,
    label: `${input.repo}#${input.number}`,
    title: input.title.slice(0, 512),
    url: input.url,
    objectType: input.objectType,
    status: input.status,
    displayType: input.objectType === "code_change" ? "Pull request" : "Issue",
    facts: input.facts,
    sourceUpdatedAt: input.sourceUpdatedAt,
  };
}

/** Refresh an existing object's status without selecting a card for delivery. */
export async function updateGitHubAnnotation(
  store: PluginAnnotations,
  input: {
    repo: string;
    number: number;
    objectType: "task" | "code_change";
    status: "merged" | "closed";
  },
): Promise<void> {
  const key = `${input.repo.toLowerCase()}#${input.number}`;
  const current = (await store.list()).find(
    (annotation) => annotation.key === key,
  );
  if (current?.kind === "object") {
    const {
      plugin: _plugin,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...annotation
    } = current;
    await store.upsert({
      ...annotation,
      objectType: input.objectType,
      status: input.status,
    });
    return;
  }
  await store.upsert({
    kind: "resource_link",
    objectType: input.objectType,
    key,
    label: `${input.repo}#${input.number}`,
    url: `https://github.com/${input.repo}/${input.objectType === "code_change" ? "pull" : "issues"}/${input.number}`,
    status: input.status,
  });
}
