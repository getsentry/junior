import { useId, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { continueConversationInSlackResponseSchema } from "@sentry/junior/api/schema";
import { useLocationDirectoryData } from "../api";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../components/ui/field";
import { MatchedLabel } from "../components/MatchedLabel";
import { quickOpenMatch } from "../components/quickOpenMatch";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command";
import { useSheet } from "../components/ui/useSheet";
import { DashboardApiError, post } from "../http";
import { conversationDetailQueryKey } from "./queries";
import { OutboundLink } from "../components/OutboundLink";

/**
 * Move a public dashboard conversation to a thread in a public Slack channel
 * that Junior already knows.
 */
export function ContinueInSlackDialog(props: {
  conversationId: string;
  onClose(): void;
}) {
  const errorId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const sheet = useSheet(props.onClose, searchRef);
  const queryClient = useQueryClient();
  const directory = useLocationDirectoryData();
  const channels = useMemo(
    () =>
      (directory.data?.locations ?? [])
        .filter(
          (location) =>
            location.provider === "slack" && location.kind === "channel",
        )
        .sort((left, right) => left.label.localeCompare(right.label)),
    [directory.data],
  );
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () => channelRows(channels, query.trim()),
    [channels, query],
  );
  const [locationId, setLocationId] = useState("");
  // A filter that hides the picked channel moves the pick to the best match.
  const selected = rows.some((row) => row.channel.id === locationId)
    ? locationId
    : (rows[0]?.channel.id ?? "");
  const move = useMutation({
    mutationFn: (id: string) =>
      post(
        continueConversationInSlackResponseSchema,
        `/api/conversations/${encodeURIComponent(props.conversationId)}/continue-in-slack`,
        { locationId: id },
      ),
    // The feed and Location pages list the conversation under its Location.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["dashboard", "conversations"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["dashboard", "locations"],
        }),
        queryClient.invalidateQueries({
          queryKey: conversationDetailQueryKey(props.conversationId),
        }),
      ]),
  });
  const submit = () => {
    if (selected && !move.isPending) move.mutate(selected);
  };
  const error = move.error
    ? (move.error instanceof DashboardApiError && move.error.apiError) ||
      "Could not move the conversation. Try again."
    : directory.error
      ? "Could not load channels. Try again."
      : undefined;

  return (
    <Dialog
      {...sheet.rootProps}
      onOpenChange={(nextOpen, details) => {
        // The Slack thread is posted once; keep the dialog until it answers.
        if (!nextOpen && move.isPending) {
          details.cancel();
          return;
        }
        sheet.rootProps.onOpenChange(nextOpen, details);
      }}
    >
      <DialogContent {...sheet.contentProps}>
        {move.data ? (
          <>
            <DialogTitle>Moved to Slack</DialogTitle>
            <p className="m-0 text-dashboard-text-muted">
              Mention Junior in the{" "}
              {move.data.channelName ? `#${move.data.channelName} ` : ""}
              thread to continue. Replies to dashboard messages stay here.
            </p>
            <DialogFooter>
              <DialogClose render={<Button>Close</Button>} />
              {move.data.locationUrl ? (
                <OutboundLink
                  className={buttonVariants({ variant: "primary" })}
                  href={move.data.locationUrl}
                >
                  Open in Slack
                </OutboundLink>
              ) : null}
            </DialogFooter>
          </>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <DialogTitle>Continue in Slack</DialogTitle>
            <Field>
              {/* cmdk names its input from `label` and owns the input id. */}
              <FieldLabel>Channel</FieldLabel>
              {/* Pointer moves do not change the pick; a click or the arrow keys do. */}
              <Command
                className="rounded-lg border border-dashboard-border"
                disablePointerSelection
                label="Channel"
                loop
                onKeyDown={(event) => {
                  // cmdk takes Enter to pick the row. The row is already
                  // picked, so Enter and Cmd/Ctrl+Enter move instead.
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) {
                    return;
                  }
                  event.preventDefault();
                  submit();
                }}
                onValueChange={setLocationId}
                shouldFilter={false}
                value={selected}
                vimBindings={false}
              >
                <CommandInput
                  ref={searchRef}
                  aria-describedby={error ? errorId : undefined}
                  aria-invalid={error ? true : undefined}
                  disabled={move.isPending}
                  onValueChange={setQuery}
                  placeholder="Search channels…"
                  spellCheck={false}
                  value={query}
                />
                <CommandList className="max-h-64 sm:max-h-64">
                  <CommandEmpty>
                    {directory.isPending
                      ? "Loading channels…"
                      : channels.length
                        ? "No matching channels."
                        : "No public channels yet."}
                  </CommandEmpty>
                  {rows.slice(0, ROW_LIMIT).map((row) => (
                    <CommandItem
                      key={row.channel.id}
                      disabled={move.isPending}
                      onSelect={setLocationId}
                      value={row.channel.id}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <MatchedLabel
                          label={row.channel.label}
                          matches={row.matches}
                        />
                      </span>
                      {row.channel.id === selected ? (
                        <Check aria-hidden="true" />
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandList>
                {rows.length > ROW_LIMIT ? (
                  <p className="m-0 border-t border-dashboard-border-subtle px-4 py-2 font-sans text-xs text-dashboard-text-muted">
                    Type to find more channels.
                  </p>
                ) : null}
              </Command>
              <FieldDescription>
                Junior starts a thread there with this conversation. You can
                move a conversation once.
              </FieldDescription>
              <FieldError id={errorId}>{error}</FieldError>
            </Field>
            <DialogFooter>
              <DialogClose
                disabled={move.isPending}
                render={<Button>Cancel</Button>}
              />
              <Button
                variant="primary"
                type="submit"
                disabled={!selected || move.isPending}
              >
                {move.isPending ? "Moving…" : "Move to channel"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Large workspaces know thousands of channels; render the best matches.
const ROW_LIMIT = 50;

type ChannelRow<T> = { channel: T; matches?: number[] };

/** Rank channels by quick-open match, like the conversation switcher. */
function channelRows<T extends { label: string }>(
  channels: T[],
  query: string,
): ChannelRow<T>[] {
  if (!query) return channels.map((channel) => ({ channel }));
  return channels
    .flatMap((channel) => {
      const match = quickOpenMatch(channel.label, query);
      return match
        ? [{ channel, matches: match.indices, score: match.score }]
        : [];
    })
    .sort((left, right) => right.score - left.score);
}
