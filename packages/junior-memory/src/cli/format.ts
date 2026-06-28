import type { juniorMemoryMemories } from "../db/schema";

function formatDate(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString();
}

/** Format a memory row as an operator-safe CLI projection. */
export function formatMemory(
  row: typeof juniorMemoryMemories.$inferSelect,
  args: {
    showContent: boolean;
  },
): string {
  const lines = [
    `id=${row.id}`,
    `scope=${row.scope}`,
    `scope_key=${row.scopeKey}`,
    `subject_type=${row.subjectType}`,
    ...(row.subjectKey ? [`subject_key=${row.subjectKey}`] : []),
    `kind=${row.kind}`,
    `created_at=${formatDate(row.createdAtMs)}`,
    `observed_at=${formatDate(row.observedAtMs)}`,
    `expires_at=${formatDate(row.expiresAtMs)}`,
    `archived_at=${formatDate(row.archivedAtMs)}`,
  ];
  if (args.showContent) {
    lines.push(`content=${row.content}`);
  }
  return lines.join("\n");
}
