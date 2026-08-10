import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { fetchDashboardJson } from "../../http";
import type { PluginUserPageRecord } from "../user/pluginUserPageData";

const memoryRecordSchema = z
  .object({
    content: z.string().min(1),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
    id: z.string().min(1),
    kind: z.enum(["preference", "procedure", "knowledge"]),
    observedAt: z.iso.datetime(),
    origin: z.enum(["automatic", "explicit", "other"]),
    sourcePlatform: z.enum(["local", "slack", "api"]),
    visibility: z.enum(["private", "public"]),
  })
  .strict();

type MemoryRecord = z.output<typeof memoryRecordSchema>;

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formattedDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

/** Project one viewer-visible memory API record into the dashboard drawer model. */
export function memoryPageRecord(memory: MemoryRecord): PluginUserPageRecord {
  const learned =
    memory.origin === "automatic"
      ? "Automatic"
      : memory.origin === "explicit"
        ? "Explicit"
        : "Other";
  return {
    actions:
      memory.visibility === "private"
        ? [
            {
              confirmation: "Forget this memory?",
              href: `/api/plugins/memory/memories/${encodeURIComponent(memory.id)}`,
              label: "Forget",
              method: "DELETE",
              tone: "danger",
            },
          ]
        : [],
    id: memory.id,
    metadata: [
      { label: "Type", value: titleCase(memory.kind) },
      { label: "Learned", value: learned },
      { label: "Source", value: titleCase(memory.sourcePlatform) },
      { label: "Visibility", value: titleCase(memory.visibility) },
      { label: "Remembered", value: formattedDate(memory.createdAt) },
      { label: "Observed", value: formattedDate(memory.observedAt) },
      {
        label: "Expires",
        value: memory.expiresAt ? formattedDate(memory.expiresAt) : "Never",
      },
    ],
    title: memory.content,
  };
}

/** Load one memory directly so its permalink does not depend on list pagination. */
export function useMemoryRecord(memoryId: string | undefined) {
  return useQuery({
    enabled: Boolean(memoryId),
    queryFn: async ({ signal }) =>
      memoryPageRecord(
        await fetchDashboardJson(
          memoryRecordSchema,
          `/api/plugins/memory/memories/${encodeURIComponent(memoryId!)}`,
          signal,
        ),
      ),
    queryKey: ["dashboard", "plugin-user-page", "memory", "record", memoryId],
    retry: false,
  });
}
