import { Eye } from "lucide-react";
import { useMemo } from "react";
import * as z from "zod";

import { useConversationsData } from "../api";
import { buildConversations } from "../format";
import type { TranscriptViewToolCallPart } from "../types";
import { TranscriptRailEvent } from "./TranscriptRailEvent";
import { ConversationLinkCard } from "./TranscriptThreadCard";

const startConversationInputSchema = z.object({ title: z.string().min(1) });

/**
 * Show a Conversation that a Lead started as a card, not a tool call: its
 * title, its status from the feed, and whether the Lead watches it.
 */
export function TranscriptStartedConversation(props: {
  /** Input of the `startConversation` call. */
  input: unknown;
  started: NonNullable<TranscriptViewToolCallPart["startedConversation"]>;
  timestamp?: number | undefined;
}) {
  const { id, watched } = props.started;
  const feed = useConversationsData();
  // A started Conversation is a root of the person, so it is a feed row.
  const conversation = useMemo(() => {
    const row = feed.data?.conversations.find(
      (item) => item.conversationId === id,
    );
    return row ? buildConversations([row])[0] : undefined;
  }, [feed.data?.conversations, id]);
  const input = startConversationInputSchema.safeParse(props.input);
  return (
    <TranscriptRailEvent kind="thread">
      <ConversationLinkCard
        conversation={conversation}
        conversationId={id}
        note={
          watched ? (
            <span className="inline-flex shrink-0 items-center gap-1 font-sans text-xs text-dashboard-text-muted">
              <Eye aria-hidden="true" className="size-3.5" strokeWidth={2} />
              Watching
            </span>
          ) : null
        }
        timestamp={props.timestamp}
        title={input.success ? input.data.title : "Conversation"}
      />
    </TranscriptRailEvent>
  );
}
