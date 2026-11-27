/**
 * The `repository` webhook of a renamed or transferred repository. Its
 * Annotations get the new name in their keys and links, so search by the
 * new name or link finds them.
 */
import type { PluginConversationAnnotations } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubRepositoryMove } from "../annotations.js";

const login = z.object({ login: z.string().min(1) });

const repositoryMoveSchema = z.object({
  action: z.enum(["renamed", "transferred"]),
  changes: z.object({
    owner: z
      .object({
        // GitHub sends the side that the repository did not belong to as
        // null.
        from: z.object({
          organization: login.nullish(),
          user: login.nullish(),
        }),
      })
      .optional(),
    repository: z
      .object({ name: z.object({ from: z.string().min(1) }) })
      .optional(),
  }),
  repository: z.object({
    full_name: z.string().min(1),
    name: z.string().min(1),
    owner: login,
  }),
});

/** Return the old and the new full name of a moved repository, if any. */
function movedRepository(
  body: unknown,
): { from: string; to: string } | undefined {
  const parsed = repositoryMoveSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const { changes, repository } = parsed.data;
  const owner =
    changes.owner?.from.organization?.login ??
    changes.owner?.from.user?.login ??
    repository.owner.login;
  const name = changes.repository?.name.from ?? repository.name;
  const from = `${owner}/${name}`;
  return from.toLowerCase() === repository.full_name.toLowerCase()
    ? undefined
    : { from, to: repository.full_name };
}

/**
 * Move the Annotations of a renamed or transferred repository to its new
 * name. Return whether the webhook moved one.
 */
export async function moveGitHubRepositoryAnnotations(
  annotations: PluginConversationAnnotations,
  body: unknown,
): Promise<boolean> {
  const moved = movedRepository(body);
  if (!moved) return false;
  await annotations.objectsMoved(githubRepositoryMove(moved.from, moved.to));
  return true;
}
