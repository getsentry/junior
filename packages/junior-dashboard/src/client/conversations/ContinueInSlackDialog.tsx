import { useId, useMemo, useRef, useState } from "react";
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
import { NativeSelect } from "../components/ui/native-select";
import { useSheet } from "../components/ui/useSheet";
import { DashboardApiError, post } from "../http";
import { conversationDetailQueryKey } from "./queries";

/**
 * Move a public dashboard conversation to a thread in a public Slack channel
 * that Junior already knows.
 */
export function ContinueInSlackDialog(props: {
  conversationId: string;
  onClose(): void;
}) {
  const selectId = useId();
  const errorId = `${selectId}-error`;
  const selectRef = useRef<HTMLSelectElement>(null);
  const sheet = useSheet(props.onClose, selectRef);
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
  const [locationId, setLocationId] = useState("");
  const selected = locationId || channels[0]?.id || "";
  const move = useMutation({
    mutationFn: (id: string) =>
      post(
        continueConversationInSlackResponseSchema,
        `/api/conversations/${encodeURIComponent(props.conversationId)}/continue-in-slack`,
        { locationId: id },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: conversationDetailQueryKey(props.conversationId),
      }),
  });
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
                <a
                  className={buttonVariants({ variant: "primary" })}
                  href={move.data.locationUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Open in Slack
                </a>
              ) : null}
            </DialogFooter>
          </>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (selected && !move.isPending) move.mutate(selected);
            }}
          >
            <DialogTitle>Continue in Slack</DialogTitle>
            <Field>
              <FieldLabel htmlFor={selectId}>Channel</FieldLabel>
              <NativeSelect
                ref={selectRef}
                id={selectId}
                aria-describedby={error ? errorId : undefined}
                aria-invalid={error ? true : undefined}
                disabled={
                  move.isPending || directory.isPending || !channels.length
                }
                onChange={(event) => setLocationId(event.target.value)}
                value={selected}
              >
                {directory.isPending ? (
                  <option value="">Loading channels…</option>
                ) : channels.length ? (
                  channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.label}
                    </option>
                  ))
                ) : (
                  <option value="">No public channels yet</option>
                )}
              </NativeSelect>
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
