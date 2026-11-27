import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, CircleOff } from "lucide-react";
import type { SpaceRefReport } from "@sentry/junior/api/schema";

import { Button } from "../components/ui/button";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../components/ui/dialog";
import { Field, FieldError, FieldLabel } from "../components/ui/field";
import { useSheet } from "../components/ui/useSheet";
import { DashboardApiError } from "../http";
import { useMemberSpacesData, useMoveConversationToSpace } from "./queries";
import type { MoveToSpaceDialogProps } from "./MoveToSpaceDialog";
import { ConversationIcon } from "../conversations/ConversationIcon";

// The "No Space" row's value. Space ids are UUIDs, so it cannot clash.
const NO_SPACE = "none";

/** The Move to Space dialog, which `MoveToSpaceDialog` loads. */
export function MoveToSpaceDialogContent(props: MoveToSpaceDialogProps) {
  const errorId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const sheet = useSheet(props.onClose, searchRef);
  const memberSpaces = useMemberSpacesData(true);
  const move = useMoveConversationToSpace(props.conversationId);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(props.current?.id ?? NO_SPACE);
  const { current } = props;
  const spaces = useMemo(() => {
    const listed: SpaceRefReport[] = memberSpaces.data?.spaces ?? [];
    const all =
      current && !listed.some((space) => space.id === current.id)
        ? [current, ...listed]
        : listed;
    const search = query.trim().toLowerCase();
    return search
      ? all.filter((space) => space.name.toLowerCase().includes(search))
      : all;
  }, [current, memberSpaces.data, query]);
  const changed = selected !== (current?.id ?? NO_SPACE);
  const submit = () => {
    if (!changed || move.isPending) return;
    move.mutate(selected === NO_SPACE ? null : selected, {
      onSuccess: () => sheet.close(),
    });
  };
  const error = move.error
    ? (move.error instanceof DashboardApiError && move.error.apiError) ||
      "Could not move the conversation. Try again."
    : memberSpaces.error
      ? "Could not load Spaces. Try again."
      : undefined;
  const row = (value: string, label: string, icon: ReactNode) => (
    <CommandItem
      disabled={move.isPending}
      key={value}
      onSelect={() => setSelected(value)}
      value={value}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value === selected ? <Check aria-hidden="true" /> : null}
    </CommandItem>
  );
  return (
    <Dialog
      {...sheet.rootProps}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && move.isPending) {
          details.cancel();
          return;
        }
        sheet.rootProps.onOpenChange(nextOpen, details);
      }}
    >
      <DialogContent {...sheet.contentProps}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogTitle>Move to Space</DialogTitle>
          <Field>
            {/* cmdk names its input from `label` and owns the input id. */}
            <FieldLabel>Space</FieldLabel>
            <Command
              className="rounded-lg border border-dashboard-border"
              disablePointerSelection
              label="Space"
              loop
              onKeyDown={(event) => {
                // cmdk takes Enter to pick the row. The row is already
                // picked, so Enter moves instead.
                if (event.key !== "Enter" || event.nativeEvent.isComposing) {
                  return;
                }
                event.preventDefault();
                submit();
              }}
              onValueChange={setSelected}
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
                placeholder="Search Spaces…"
                spellCheck={false}
                value={query}
              />
              <CommandList className="max-h-64 sm:max-h-64">
                {query.trim()
                  ? null
                  : row(
                      NO_SPACE,
                      "No Space",
                      <CircleOff
                        aria-hidden="true"
                        className="text-dashboard-text-muted"
                      />,
                    )}
                {spaces.map((space) =>
                  row(
                    space.id,
                    space.name,
                    <ConversationIcon
                      iconId={space.id}
                      name={space.name}
                      size="sm"
                    />,
                  ),
                )}
              </CommandList>
            </Command>
            <FieldError id={errorId}>{error}</FieldError>
          </Field>
          <DialogFooter>
            <DialogClose
              disabled={move.isPending}
              render={<Button variant="outline">Cancel</Button>}
            />
            <Button
              disabled={!changed || move.isPending}
              type="submit"
              variant="default"
            >
              {move.isPending ? "Moving…" : "Move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
