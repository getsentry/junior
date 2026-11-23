import * as z from "zod";

import { fetchDashboardJson } from "../../http";

// The body of `GET /api/memory/search`.
const memorySearchSchema = z
  .object({
    memories: z.array(
      z.object({ content: z.string().min(1), id: z.string().min(1) }).strict(),
    ),
  })
  .strict();

/**
 * Find active public memories for quick pickers, such as Cmd+K and the
 * composer `@` menu. Each typed word must start a word of the memory. The
 * server returns at most 8, newest first.
 */
export async function searchMemories(
  query: string,
  signal?: AbortSignal,
): Promise<Array<{ content: string; id: string }>> {
  const report = await fetchDashboardJson(
    memorySearchSchema,
    `/api/memory/search?${new URLSearchParams({ q: query })}`,
    signal,
  );
  return report.memories;
}
