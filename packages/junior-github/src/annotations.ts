import {
  objectFactsMatchType,
  type ConversationAnnotation,
  type ConversationSidebarAnnotation,
  type ObjectAnnotation,
  type PluginAnnotations,
  type PluginConversationAnnotations,
  type PluginLogger,
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
                ...(annotation.kind === "object"
                  ? { title: annotation.title }
                  : {}),
                ...(annotation.url ? { url: annotation.url } : {}),
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
  description?: string;
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
    description: input.description,
    sourceUpdatedAt: input.sourceUpdatedAt,
  };
}

/** Refresh an existing object's status without selecting a card for delivery. */
async function updateGitHubAnnotation(
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
      facts,
      ...annotation
    } = current;
    await store.upsert({
      ...annotation,
      // Facts saved for another object type are not valid for this one.
      ...(facts && objectFactsMatchType(facts, input.objectType)
        ? { facts }
        : undefined),
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

/**
 * Refresh the status of one object in each linked conversation. One failed
 * conversation does not stop the others. Each failure is logged.
 */
export async function updateGitHubAnnotations(args: {
  annotations: PluginConversationAnnotations;
  conversationIds: string[];
  log?: Pick<PluginLogger, "error">;
  update: Parameters<typeof updateGitHubAnnotation>[1];
}): Promise<void> {
  const results = await Promise.allSettled(
    args.conversationIds.map((conversationId) =>
      updateGitHubAnnotation(
        args.annotations.forConversation(conversationId),
        args.update,
      ),
    ),
  );
  for (const result of results) {
    if (result.status === "fulfilled") continue;
    args.log?.error("GitHub conversation annotation update failed", {
      errorType:
        result.reason instanceof Error ? result.reason.name : "UnknownError",
      number: args.update.number,
      objectType: args.update.objectType,
      repository: args.update.repo,
    });
  }
}
