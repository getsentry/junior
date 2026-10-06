import { z } from "zod";

const text = z.string().trim().min(1).max(160);
const count = z.number().int().nonnegative();

/** Small, provider-neutral facts. Missing values mean unknown, not success. */
export const objectFactsSchema = z.discriminatedUnion("type", [
  // Code changes: keep lifecycle, review, and checks separate.
  z.strictObject({
    type: z.literal("code_change"),
    author: text.optional(),
    sourceBranch: text.optional(),
    targetBranch: text.optional(),
    reviewers: z.array(text).max(5).optional(),
    review: z.enum(["required", "approved", "changes_requested"]).optional(),
    checks: z
      .strictObject({ passed: count, failed: count, pending: count })
      .optional(),
    mergeable: z.boolean().optional(),
    changedFiles: count.optional(),
    additions: count.optional(),
    deletions: count.optional(),
  }),
  // Tasks: ownership and priority first; planning context comes next.
  z.strictObject({
    type: z.literal("task"),
    assignees: z.array(text).max(5).optional(),
    priority: text.optional(),
    project: text.optional(),
    cycle: text.optional(),
    dueDate: z.iso.date().optional(),
    labels: z.array(text).max(5).optional(),
  }),
  // Deployments: never copy environment values or logs.
  z.strictObject({
    type: z.literal("deployment"),
    project: text.optional(),
    environment: text.optional(),
    revision: text.optional(),
    branch: text.optional(),
  }),
]);
export type ObjectFacts = z.output<typeof objectFactsSchema>;

type ObjectField = { key: string; label: string; value: string };

/** Show at most four card attributes, in priority order, on every surface. */
export function objectFactFields(
  facts: ObjectFacts | undefined,
): ObjectField[] {
  if (!facts) return [];
  const fields: ObjectField[] = [];
  const list = (values: string[] | undefined) =>
    values?.length
      ? `${values.join(", ")}${values.length === 5 ? " (up to 5 shown)" : ""}`
      : undefined;
  function add(key: string, label: string, value: string | number | undefined) {
    if (value !== undefined && value !== "")
      fields.push({ key, label, value: String(value) });
  }
  switch (facts.type) {
    case "code_change":
      // Keep cards minimal. Review, checks, and conflicts can become stale.
      add("sourceBranch", "Branch", facts.sourceBranch);
      break;
    case "task":
      add(
        "assignees",
        "Assignees",
        facts.assignees?.length === 0 ? "Unassigned" : list(facts.assignees),
      );
      add("priority", "Priority", facts.priority);
      add("project", "Project", facts.project);
      add("cycle", "Cycle", facts.cycle);
      add("dueDate", "Due", facts.dueDate);
      add("labels", "Labels", list(facts.labels));
      break;
    case "deployment":
      add("environment", "Environment", facts.environment);
      add("project", "Project", facts.project);
      add("revision", "Revision", facts.revision);
      add("branch", "Branch", facts.branch);
      break;
  }
  return fields.slice(0, 4);
}
