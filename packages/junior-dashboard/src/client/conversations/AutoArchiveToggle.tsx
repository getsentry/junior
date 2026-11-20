import { useId } from "react";
import { CircleHelp } from "lucide-react";

import { Checkbox } from "../components/ui/checkbox";
import { Field, FieldLabel } from "../components/ui/field";
import { InlineError } from "../components/InlineError";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTrigger,
} from "../components/ui/popover";
import { useSetConversationAutoArchive } from "./autoArchiveQueries";

const AUTO_ARCHIVE_HELP =
  "Archive this conversation for everyone when its linked work is merged or closed and nobody replies during your wait time.";

/** Let a participant turn auto-archive on or off for this conversation. */
export function AutoArchiveToggle(props: {
  autoArchive: boolean;
  conversationId: string;
}) {
  const update = useSetConversationAutoArchive(props.conversationId);
  const checkboxId = useId();
  const helpId = useId();
  return (
    <div className="grid gap-1">
      <Field className="w-fit" orientation="horizontal">
        <Checkbox
          aria-describedby={helpId}
          checked={props.autoArchive}
          disabled={update.isPending}
          id={checkboxId}
          onCheckedChange={(checked) => update.mutate(checked)}
        />
        <FieldLabel htmlFor={checkboxId}>Auto archive</FieldLabel>
        {/* A popover, not a tooltip: touch screens open it with a tap. */}
        <Popover>
          <PopoverTrigger
            delay={0}
            openOnHover
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
          <PopoverContent
            aria-label="About auto archive"
            className="w-64 px-3 py-2 text-xs"
            side="top"
          >
            <PopoverDescription>{AUTO_ARCHIVE_HELP}</PopoverDescription>
          </PopoverContent>
        </Popover>
        {/* Keep the help text for screen readers when the popover is closed. */}
        <span className="sr-only" id={helpId}>
          {AUTO_ARCHIVE_HELP}
        </span>
      </Field>
      {update.isError ? (
        <InlineError>Could not save auto-archive. Try again.</InlineError>
      ) : null}
    </div>
  );
}
