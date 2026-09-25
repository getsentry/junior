import type { ObjectAnnotation } from "@sentry/junior-plugin-api";
import { z } from "zod";

const person = z.object({ login: z.string() });
const responseSchema = z.object({
  user: person.nullable().optional(),
  requested_reviewers: z.array(person).optional(),
  assignees: z.array(person).optional(),
  labels: z
    .array(z.union([z.string(), z.object({ name: z.string() })]))
    .optional(),
  head: z.object({ ref: z.string() }).optional(),
  base: z.object({ ref: z.string() }).optional(),
  mergeable: z.boolean().nullable().optional(),
  changed_files: z.number().int().nonnegative().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
});
const short = (value: string | undefined) => {
  const text = value?.trim();
  return text ? (text.length > 64 ? `${text.slice(0, 63)}…` : text) : undefined;
};

/** Select card facts from GitHub REST responses; never infer reviews or checks. */
export function githubObjectFacts(
  type: "task" | "code_change",
  response: unknown,
): Pick<ObjectAnnotation, "facts" | "sourceUpdatedAt"> {
  const data = responseSchema.parse(response);
  return {
    sourceUpdatedAt: data.updated_at,
    facts:
      type === "code_change"
        ? {
            type,
            author: short(data.user?.login),
            reviewers: data.requested_reviewers
              ?.slice(0, 5)
              .map((user) => short(user.login)!)
              .filter(Boolean),
            sourceBranch: short(data.head?.ref),
            targetBranch: short(data.base?.ref),
            mergeable: data.mergeable ?? undefined,
            changedFiles: data.changed_files,
            additions: data.additions,
            deletions: data.deletions,
          }
        : {
            type,
            assignees: data.assignees
              ?.slice(0, 5)
              .map((user) => short(user.login)!)
              .filter(Boolean),
            labels: data.labels
              ?.slice(0, 5)
              .map(
                (label) =>
                  short(typeof label === "string" ? label : label.name)!,
              )
              .filter(Boolean),
          },
  };
}
