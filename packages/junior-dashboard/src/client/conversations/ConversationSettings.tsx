import { useId } from "react";
import { CircleHelp } from "lucide-react";

import { Checkbox } from "../components/ui/checkbox";
import { InlineError } from "../components/InlineError";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTrigger,
} from "../components/ui/popover";
import { useSetConversationAutoArchive } from "./autoArchiveQueries";
import { useConversationSubscription } from "./useConversationSubscription";

/**
 * Render the participant's own settings for this conversation. A setting
 * that the detail does not return for this viewer is hidden.
 */
export function ConversationSettings(props: {
  autoArchive: boolean | undefined;
  conversationId: string;
  subscribed: boolean | undefined;
}) {
  return (
    <div className="grid gap-2.5">
      {props.subscribed === undefined ? null : (
        <SubscriptionToggle
          conversationId={props.conversationId}
          subscribed={props.subscribed}
        />
      )}
      {props.autoArchive === undefined ? null : (
        <AutoArchiveToggle
          autoArchive={props.autoArchive}
          conversationId={props.conversationId}
        />
      )}
    </div>
  );
}

function SubscriptionToggle(props: {
  conversationId: string;
  subscribed: boolean;
}) {
  const update = useConversationSubscription(props.conversationId);
  return (
    <SettingToggle
      checked={props.subscribed}
      error={
        update.isError ? "Could not save the subscription. Try again." : null
      }
      help="Show this conversation in your feed. Unsubscribe to leave it to the others. Your next mention of Junior here subscribes you again. When nobody else is subscribed, unsubscribe archives it for everyone."
      about="About subscription"
      label="Subscribed"
      onChange={(checked) => update.mutate(checked)}
      pending={update.isPending}
    />
  );
}

function AutoArchiveToggle(props: {
  autoArchive: boolean;
  conversationId: string;
}) {
  const update = useSetConversationAutoArchive(props.conversationId);
  return (
    <SettingToggle
      checked={props.autoArchive}
      error={update.isError ? "Could not save auto-archive. Try again." : null}
      help="Archive this conversation for everyone when its linked work is merged or closed and nobody replies during your wait time."
      about="About auto archive"
      label="Auto archive"
      onChange={(checked) => update.mutate(checked)}
      pending={update.isPending}
    />
  );
}

function SettingToggle(props: {
  about: string;
  checked: boolean;
  error: string | null;
  help: string;
  label: string;
  onChange(checked: boolean): void;
  pending: boolean;
}) {
  const helpId = useId();
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-1.5">
        <label className="flex cursor-pointer items-center gap-2.5">
          <Checkbox
            aria-describedby={helpId}
            checked={props.checked}
            disabled={props.pending}
            onCheckedChange={props.onChange}
          />
          <span className="font-semibold text-dashboard-text">
            {props.label}
          </span>
        </label>
        {/* A popover, not a tooltip: touch screens open it with a tap. */}
        <Popover>
          <PopoverTrigger
            delay={0}
            openOnHover
            render={
              <button
                aria-label={props.about}
                className="grid place-items-center rounded-sm text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
                type="button"
              >
                <CircleHelp aria-hidden="true" size={14} strokeWidth={2} />
              </button>
            }
          />
          <PopoverContent
            aria-label={props.about}
            className="w-64 px-3 py-2 text-xs"
            side="top"
          >
            <PopoverDescription>{props.help}</PopoverDescription>
          </PopoverContent>
        </Popover>
        {/* Keep the help text for screen readers when the popover is closed. */}
        <span className="sr-only" id={helpId}>
          {props.help}
        </span>
      </div>
      {props.error ? <InlineError>{props.error}</InlineError> : null}
    </div>
  );
}
