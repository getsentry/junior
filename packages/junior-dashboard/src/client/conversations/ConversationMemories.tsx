import { useQuery } from "@tanstack/react-query";
import { Brain } from "lucide-react";
import { z } from "zod";

import { formatMessageTimestamp } from "../format";
import { fetchDashboardJson } from "../http";

const conversationMemoryListSchema = z
  .object({
    memories: z.array(
      z
        .object({
          capturedAt: z.iso.datetime(),
          content: z.string().min(1),
          id: z.string().min(1),
          kind: z.enum(["preference", "procedure", "knowledge"]),
          visibility: z.enum(["private", "public"]),
        })
        .strict(),
    ),
  })
  .strict();

/** Load and show the memories captured from one Conversation. */
export function ConversationMemories(props: { conversationId: string }) {
  const query = useQuery({
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationMemoryListSchema,
        `/api/plugins/memory/conversations/${encodeURIComponent(props.conversationId)}/memories`,
        signal,
      ),
    queryKey: ["conversation", props.conversationId, "memories"],
    retry: false,
  });

  if (query.isPending) {
    return (
      <p className="m-0 text-sm text-dashboard-text-muted" role="status">
        Loading memories…
      </p>
    );
  }
  if (query.error) {
    return (
      <p className="m-0 text-sm text-red-300/80">
        Could not load memories from this Conversation.
      </p>
    );
  }
  if (query.data.memories.length === 0) {
    return (
      <div className="grid justify-items-center gap-2 py-10 text-center text-dashboard-text-muted">
        <Brain aria-hidden="true" className="size-5 opacity-60" />
        <p className="m-0 text-sm">No memories were captured.</p>
      </div>
    );
  }

  return (
    <ol className="m-0 grid list-none gap-3 p-0">
      {query.data.memories.map((memory) => (
        <li
          className="grid gap-2 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface px-3 py-3"
          key={memory.id}
        >
          <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-dashboard-text">
            {memory.content}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-dashboard-text-muted">
            <span className="rounded border border-dashboard-border-subtle bg-dashboard-surface-raised px-1.5 py-0.5">
              {memory.kind}
            </span>
            <span className="rounded border border-dashboard-border-subtle bg-dashboard-surface-raised px-1.5 py-0.5">
              {memory.visibility}
            </span>
            <time className="ml-auto" dateTime={memory.capturedAt}>
              {formatMessageTimestamp(Date.parse(memory.capturedAt), true)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}
