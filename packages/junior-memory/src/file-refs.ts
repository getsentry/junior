import type { PluginRunTranscriptEntry } from "@sentry/junior-plugin-api";
import { juniorMemoryFileRefs } from "./db/schema";
import type { MemoryDb } from "./store";

/**
 * Collect the Sandbox files named by cited successful tool results. Failed
 * tool calls are not evidence, so their files are not provenance.
 */
export function citedFilePaths(
  indices: number[],
  transcript: PluginRunTranscriptEntry[],
): string[] {
  const paths = new Set<string>();
  for (const index of indices) {
    const entry = transcript[index];
    if (entry?.type !== "toolResult" || entry.isError) {
      continue;
    }
    for (const path of entry.paths ?? []) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

/** Link a memory to the Sandbox files it was learned from. Repeats are no-ops. */
export async function addMemoryFileRefs(args: {
  conversationId?: string;
  db: MemoryDb;
  memoryId: string;
  nowMs: number;
  paths: string[];
}): Promise<void> {
  if (args.paths.length === 0) {
    return;
  }
  await args.db
    .insert(juniorMemoryFileRefs)
    .values(
      args.paths.map((path) => ({
        conversationId: args.conversationId,
        memoryId: args.memoryId,
        observedAtMs: args.nowMs,
        path,
      })),
    )
    .onConflictDoNothing();
}
