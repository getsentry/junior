import type { juniorMemoryMemories } from "../db/schema";

function preview(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) {
    return compact;
  }
  return `${compact.slice(0, 117)}...`;
}

function formatDate(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString();
}

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
    `type=${row.type}`,
    `created_at=${formatDate(row.createdAtMs)}`,
    `observed_at=${formatDate(row.observedAtMs)}`,
    `expires_at=${formatDate(row.expiresAtMs)}`,
    `archived_at=${formatDate(row.archivedAtMs)}`,
  ];
  if (args.showContent) {
    lines.push(`content=${row.content}`);
  } else {
    lines.push(`preview=${preview(row.content)}`);
  }
  return lines.join("\n");
}
