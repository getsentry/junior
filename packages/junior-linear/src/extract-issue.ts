import { z } from "zod";

export type LinearIssueLink = {
  identifier: string;
  url: string;
};

const saveIssueResultSchema = z
  .object({
    issue: z
      .object({
        identifier: z.string().trim().min(1),
        url: z.url(),
      })
      .passthrough(),
  })
  .passthrough();

/** Extract issue identity from Linear's structured save response. */
export function extractLinearIssueLink(value: unknown): LinearIssueLink | null {
  const parsed = saveIssueResultSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return {
    identifier: parsed.data.issue.identifier.toUpperCase(),
    url: parsed.data.issue.url,
  };
}
