import { Checkbox } from "../components/ui/checkbox";
import { InlineError } from "../components/InlineError";
import { useSetConversationAutoArchive } from "./autoArchiveQueries";

/** Let a participant turn auto-archive on or off for this conversation. */
export function AutoArchiveToggle(props: {
  autoArchive: boolean;
  conversationId: string;
}) {
  const update = useSetConversationAutoArchive(props.conversationId);
  return (
    <div className="grid gap-1">
      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox
          checked={props.autoArchive}
          className="mt-0.5"
          disabled={update.isPending}
          onCheckedChange={(checked) => update.mutate(checked)}
        />
        <span className="grid gap-0.5">
          <span className="font-semibold text-dashboard-text">
            Auto-archive when done
          </span>
          <span>
            Archive this conversation for you when its linked work is merged or
            closed and nobody replies during your wait time.
          </span>
        </span>
      </label>
      {update.isError ? (
        <InlineError>Could not save auto-archive. Try again.</InlineError>
      ) : null}
    </div>
  );
}
