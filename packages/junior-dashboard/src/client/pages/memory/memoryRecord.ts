import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import * as z from "zod";

import { fetchDashboardJson, patch } from "../../http";
import type { PluginUserPageRecord } from "../user/pluginUserPageData";
import { formatTime } from "../../time";

const memoryRecordSchema = z
  .object({
    archivedAt: z.iso.datetime().optional(),
    archiveReason: z.string().min(1).optional(),
    content: z.string().min(1),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
    id: z.string().min(1),
    kind: z.enum(["preference", "procedure", "knowledge"]),
    observedAt: z.iso.datetime(),
    origin: z.enum(["automatic", "explicit", "other"]),
    sourcePlatform: z.enum(["local", "slack", "web"]),
  })
  .strict();

type MemoryRecord = z.output<typeof memoryRecordSchema>;

// Why a memory left recall, by `archive_reason`, as the plugin page labels it.
const ARCHIVE_REASON_LABELS: Record<string, string> = {
  contradicted: "Contradicted",
  superseded: "Replaced",
  tool_removed: "Forgotten",
  user_removed: "Forgotten",
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formattedDate(value: string): string {
  return formatTime(value, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

function memoryHref(memoryId: string): string {
  return `/api/memory/memories/${encodeURIComponent(memoryId)}`;
}

/** Project one viewer-visible memory API record into the dashboard details model. */
export function memoryPageRecord(memory: MemoryRecord): PluginUserPageRecord {
  const learned =
    memory.origin === "automatic"
      ? "Automatic"
      : memory.origin === "explicit"
        ? "Explicit"
        : "Other";
  return {
    // An archived memory has no Forget action; useRestoreMemory restores it.
    ...(memory.archivedAt
      ? undefined
      : {
          actions: [
            {
              confirmation: "Forget this memory for everyone?",
              href: memoryHref(memory.id),
              label: "Forget",
              method: "DELETE" as const,
              tone: "danger" as const,
            },
          ],
        }),
    id: memory.id,
    metadata: [
      { label: "Type", value: titleCase(memory.kind) },
      { label: "Learned", value: learned },
      { label: "Source", value: titleCase(memory.sourcePlatform) },
      { label: "Remembered", value: formattedDate(memory.createdAt) },
      { label: "Observed", value: formattedDate(memory.observedAt) },
      {
        label: "Expires",
        value: memory.expiresAt ? formattedDate(memory.expiresAt) : "Never",
      },
      ...(memory.archivedAt
        ? [
            { label: "Archived", value: formattedDate(memory.archivedAt) },
            {
              label: "Reason",
              value:
                ARCHIVE_REASON_LABELS[memory.archiveReason ?? ""] ?? "Archived",
            },
          ]
        : []),
    ],
    title: memory.content,
  };
}

/**
 * Load one active or archived memory directly so its permalink does not
 * depend on list pagination.
 */
export function useMemoryRecord(
  memoryId: string | undefined,
  archived: boolean,
) {
  return useQuery({
    enabled: Boolean(memoryId),
    queryFn: async ({ signal }) =>
      memoryPageRecord(
        await fetchDashboardJson(
          memoryRecordSchema,
          `${memoryHref(memoryId!)}${archived ? "?archived=true" : ""}`,
          signal,
        ),
      ),
    queryKey: [
      "dashboard",
      "plugin-user-page",
      "memory",
      "record",
      memoryId,
      archived,
    ],
    retry: false,
  });
}

/** Make one archived memory active again, then refresh memory pages. */
export function useRestoreMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memoryId: string) =>
      patch(memoryRecordSchema, memoryHref(memoryId), { archived: false }),
    onSuccess: async () => {
      // As after a forget, drop detail caches before lists refresh.
      queryClient.removeQueries({
        queryKey: ["dashboard", "plugin-user-page", "memory", "record"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["dashboard", "plugin-user-page", "memory"],
      });
    },
  });
}

/**
 * Whether the list shows rows for `filter`. After a tab switch the list keeps
 * the previous tab's rows as placeholder data until the new rows load.
 */
export function useListShowsFilter(filter: string, settled: boolean): boolean {
  const [shownFilter, setShownFilter] = useState(filter);
  if (settled && shownFilter !== filter) setShownFilter(filter);
  return shownFilter === filter;
}
