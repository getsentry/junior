import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { WalkthroughVersionResponse } from "@sentry/junior/api/schema";

import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../components/ui/popover";
import {
  ConversationUsageTables,
  hasConversationUsageBreakdown,
} from "../conversations/ConversationUsageBreakdown";
import { conversationPath } from "../conversations/conversationRoutes";
import { conversationDetailQueryOptions } from "../conversations/queries";
import { conversationFromDetail } from "../format";
import { cn } from "../styles";

/**
 * What this version cost. The number opens the usage tables that
 * Conversation details shows for the generation Conversation, already open,
 * with a link to its transcript.
 */
export function WalkthroughCost(props: {
  className: string;
  version: WalkthroughVersionResponse;
}) {
  const { version } = props;
  const [open, setOpen] = useState(false);
  if (version.costUsd === undefined) return null;
  const cost = `$${version.costUsd.toFixed(2)}`;
  const generationId = version.generationConversationId;
  const label =
    version.status === "generating"
      ? "What this Walkthrough has cost so far"
      : "What it cost to make this Walkthrough";
  if (!generationId) {
    return (
      <span className="tabular-nums" title={label}>
        {cost}
      </span>
    );
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        delay={150}
        openOnHover
        render={
          <button
            aria-label={`${label}: ${cost}`}
            className={cn(
              props.className,
              "cursor-pointer border-0 bg-transparent p-0 tabular-nums",
            )}
            type="button"
          >
            {cost}
          </button>
        }
      />
      <PopoverContent align="start" className="grid w-96 gap-3">
        <PopoverTitle>
          {label}: <span className="tabular-nums">{cost}</span>
        </PopoverTitle>
        {open ? <GenerationUsage conversationId={generationId} /> : null}
        <Link
          className="w-fit text-sm text-dashboard-text underline underline-offset-4"
          to={conversationPath(generationId)}
        >
          Open the generation transcript
        </Link>
      </PopoverContent>
    </Popover>
  );
}

/** The usage breakdown of one generation Conversation, read when opened. */
function GenerationUsage(props: { conversationId: string }) {
  const detail = useQuery(
    conversationDetailQueryOptions(props.conversationId),
  ).data;
  if (!detail) {
    return (
      <p className="m-0 text-sm text-dashboard-text-muted">Loading usage…</p>
    );
  }
  const conversation = conversationFromDetail(detail);
  if (!hasConversationUsageBreakdown({ conversation, detail })) {
    return (
      <p className="m-0 text-sm text-dashboard-text-muted">
        No usage was recorded.
      </p>
    );
  }
  return (
    <ConversationUsageTables conversation={conversation} detail={detail} />
  );
}
