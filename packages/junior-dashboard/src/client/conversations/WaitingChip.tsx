import { ChevronRight, Inbox } from "lucide-react";
import { Link } from "react-router";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import type { WaitingConversation } from "../review-desk/queries";
import { cn } from "../styles";
import { NeedsYouMarker } from "../components/NeedsYouMarker";
import { conversationPath } from "./conversationRoutes";
import { GitHubMark } from "./GitHubMark";
import { pluginSource } from "./transcriptSource";

/** Show the plugin's mark for a plugin item, and the Inbox icon otherwise. */
function WaitingItemMark(props: { plugin?: string }) {
  return pluginSource(props.plugin) === "github" ? (
    <GitHubMark className="size-3 shrink-0 text-dashboard-text-muted" />
  ) : (
    <Inbox
      aria-hidden="true"
      className="size-3 shrink-0 text-dashboard-text-muted"
    />
  );
}

/**
 * Link a waiting row to its open Review items. The chip shows the newest
 * title, and its tooltip lists every title in full.
 */
export function WaitingChip(props: {
  conversationId: string;
  /** Prototype `?needsYou=marker`: lead with the Needs you marker. */
  marker?: boolean;
  waiting: WaitingConversation;
}) {
  const [newest, ...older] = props.waiting.items;
  if (!newest) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            className="mb-1.5 ml-[2.25rem] mr-2 flex min-w-0 items-center gap-1.5 rounded-md border border-dashboard-border-strong bg-dashboard-surface-raised px-2 py-1 font-sans text-xs text-dashboard-text no-underline transition-colors hover:border-dashboard-border-interactive focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus"
            to={conversationPath(props.conversationId, { reviewItems: true })}
          >
            {props.marker ? <NeedsYouMarker /> : null}
            <WaitingItemMark plugin={newest.plugin} />
            <span className="min-w-0 truncate">{newest.title}</span>
            {older.length > 0 ? (
              <span className="ml-auto shrink-0 text-dashboard-text-faint">
                +{older.length} more
              </span>
            ) : null}
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0 text-dashboard-text-muted",
                older.length > 0 ? undefined : "ml-auto",
              )}
            />
          </Link>
        }
      />
      <TooltipContent align="start" side="right">
        <ul className="flex flex-col gap-1">
          {props.waiting.items.map((item, index) => (
            <li
              className="flex items-start gap-1.5 text-dashboard-text"
              key={index}
            >
              <span className="mt-0.5 flex">
                <WaitingItemMark plugin={item.plugin} />
              </span>
              <span className="min-w-0 break-words">{item.title}</span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
