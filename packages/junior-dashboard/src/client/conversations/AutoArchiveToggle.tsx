import { useId } from "react";
import { CircleHelp } from "lucide-react";

import { Checkbox } from "../components/ui/checkbox";
import { InlineError } from "../components/InlineError";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { useSetConversationAutoArchive } from "./autoArchiveQueries";

const AUTO_ARCHIVE_HELP =
  "Archive this conversation for you when its linked work is merged or closed and nobody replies during your wait time.";

/** Let a participant turn auto-archive on or off for this conversation. */
export function AutoArchiveToggle(props: {
  autoArchive: boolean;
  conversationId: string;
}) {
  const update = useSetConversationAutoArchive(props.conversationId);
  const helpId = useId();
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-1.5">
        <label className="flex cursor-pointer items-center gap-2.5">
          <Checkbox
            aria-describedby={helpId}
            checked={props.autoArchive}
            disabled={update.isPending}
            onCheckedChange={(checked) => update.mutate(checked)}
          />
          <span className="font-semibold text-dashboard-text">
            Auto archive
          </span>
        </label>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-label="About auto archive"
                className="grid place-items-center rounded-sm text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
                type="button"
              >
                <CircleHelp aria-hidden="true" size={14} strokeWidth={2} />
              </button>
            }
          />
          <TooltipContent className="max-w-64">
            {AUTO_ARCHIVE_HELP}
          </TooltipContent>
        </Tooltip>
        {/* Keep the help text for screen readers when the tooltip is closed. */}
        <span className="sr-only" id={helpId}>
          {AUTO_ARCHIVE_HELP}
        </span>
      </div>
      {update.isError ? (
        <InlineError>Could not save auto-archive. Try again.</InlineError>
      ) : null}
    </div>
  );
}
