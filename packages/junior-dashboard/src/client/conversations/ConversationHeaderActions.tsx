import type { ReactNode, Ref } from "react";
import {
  Archive,
  ArchiveRestore,
  Info,
  PanelRight,
  MessagesSquare,
  ScrollText,
  Search,
  X,
} from "lucide-react";

import { Button } from "../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { cn } from "../styles";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import { ShareConversationButton } from "./ShareConversationButton";

export type ConversationArchiveAction = {
  archived: boolean;
  disabled: boolean;
  error: boolean;
  onClick(): void;
  pending: boolean;
};

/** Show conversation actions in the header or mobile menu. */
export function ConversationHeaderActions(props: {
  archive: ConversationArchiveAction;
  conversationId: string;
  copyAction?: ReactNode;
  detailsOpen: boolean;
  detailsButtonRef?: Ref<HTMLButtonElement>;
  /** `bar` is the desktop icon row. `menu` stacks actions for mobile overflow. */
  layout?: "bar" | "menu";
  onDetailsClick(): void;
  onSearchClick(): void;
  onViewChange(value: TranscriptViewMode): void;
  searchOpen: boolean;
  view: TranscriptViewMode;
}) {
  const layout = props.layout ?? "bar";
  if (layout === "menu") {
    return (
      <div className="grid gap-0.5">
        {props.view === "rich" ? (
          <MenuActionButton
            label={props.searchOpen ? "Hide search" : "Search transcript"}
            onClick={props.onSearchClick}
            pressed={props.searchOpen}
          >
            {props.searchOpen ? (
              <X aria-hidden="true" size={16} strokeWidth={2} />
            ) : (
              <Search aria-hidden="true" size={16} strokeWidth={2} />
            )}
          </MenuActionButton>
        ) : null}
        <MenuActionButton
          label="Conversation"
          onClick={() => props.onViewChange("rich")}
          pressed={props.view === "rich"}
        >
          <MessagesSquare aria-hidden="true" size={16} strokeWidth={2} />
        </MenuActionButton>
        <MenuActionButton
          label="Event log"
          onClick={() => props.onViewChange("raw")}
          pressed={props.view === "raw"}
        >
          <ScrollText aria-hidden="true" size={16} strokeWidth={2} />
        </MenuActionButton>
        <ShareConversationButton
          key={props.conversationId}
          conversationId={props.conversationId}
          layout="menu"
        />
        {props.copyAction}
        <ArchiveConversationButton {...props.archive} layout="menu" />
        <MenuActionButton
          label="Conversation details"
          onClick={props.onDetailsClick}
          pressed={props.detailsOpen}
        >
          <Info aria-hidden="true" size={16} strokeWidth={2} />
        </MenuActionButton>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {props.view === "rich" ? (
        <TranscriptSearchToggle
          onClick={props.onSearchClick}
          open={props.searchOpen}
        />
      ) : null}
      {props.copyAction}
      <ArchiveConversationButton {...props.archive} layout="bar" />
      <Button
        ref={props.detailsButtonRef}
        aria-label="Conversation details"
        aria-pressed={props.detailsOpen}
        className="ml-2"
        onClick={props.onDetailsClick}
      >
        <PanelRight aria-hidden="true" size={15} strokeWidth={2} />
        Details
      </Button>
    </div>
  );
}

/** Switch between the conversation and event log. */
export function TranscriptViewToggle(props: {
  labelled?: boolean;
  onChange(value: TranscriptViewMode): void;
  value: TranscriptViewMode;
}) {
  return (
    <ToggleGroup
      aria-label="Transcript view"
      className={
        props.labelled
          ? "inline-flex gap-6"
          : "inline-flex gap-0.5 rounded-md border border-dashboard-border bg-dashboard-overlay-soft p-0.5"
      }
      onValueChange={([next]) => {
        if (next) props.onChange(next);
      }}
      value={[props.value]}
    >
      <ViewModeItem label="Conversation" labelled={props.labelled} value="rich">
        <MessagesSquare aria-hidden="true" size={14} strokeWidth={2} />
      </ViewModeItem>
      <ViewModeItem label="Event log" labelled={props.labelled} value="raw">
        <ScrollText aria-hidden="true" size={14} strokeWidth={2} />
      </ViewModeItem>
    </ToggleGroup>
  );
}

function ViewModeItem(props: {
  children: ReactNode;
  label: string;
  labelled?: boolean;
  value: TranscriptViewMode;
}) {
  const item = (
    <ToggleGroupItem
      aria-label={props.label}
      className={
        props.labelled
          ? "relative h-11 min-w-0 gap-2 rounded-none border-0 px-0 text-sm hover:bg-transparent after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 data-pressed:border-0 data-pressed:bg-transparent data-pressed:after:bg-dashboard-text-solid"
          : "size-7 min-w-0 border-0 px-0 data-pressed:border-0 data-pressed:bg-dashboard-fill-hover"
      }
      value={props.value}
    >
      {props.children}
      {props.labelled ? props.label : null}
    </ToggleGroupItem>
  );
  return props.labelled ? (
    item
  ) : (
    <Tooltip>
      <TooltipTrigger render={item} />
      <TooltipContent size="compact">{props.label}</TooltipContent>
    </Tooltip>
  );
}

/** Shared icon control used by conversation and subagent transcript headers. */
export function HeaderIconButton(props: {
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
  label: string;
  onClick(): void;
  pressed?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={props.ref}
            aria-label={props.label}
            aria-pressed={props.pressed}
            className={cn(
              "text-dashboard-text-muted",
              props.pressed && "bg-dashboard-fill-strong text-dashboard-text",
            )}
            onClick={props.onClick}
            size="icon"
          >
            {props.children}
          </Button>
        }
      />
      <TooltipContent size="compact">{props.label}</TooltipContent>
    </Tooltip>
  );
}

/** Toggle transcript search visibility with the shared header icon control. */
export function TranscriptSearchToggle(props: {
  onClick(): void;
  open: boolean;
}) {
  return (
    <HeaderIconButton
      label={props.open ? "Hide search" : "Search transcript"}
      onClick={props.onClick}
      pressed={props.open}
    >
      {props.open ? (
        <X aria-hidden="true" size={15} strokeWidth={2} />
      ) : (
        <Search aria-hidden="true" size={15} strokeWidth={2} />
      )}
    </HeaderIconButton>
  );
}

function MenuActionButton(props: {
  children: ReactNode;
  label: string;
  onClick(): void;
  pressed?: boolean;
}) {
  return (
    <button
      aria-label={props.label}
      aria-pressed={props.pressed}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-semibold text-dashboard-text transition-colors hover:bg-dashboard-fill-strong focus-visible:bg-dashboard-fill-strong focus-visible:outline-none",
        props.pressed && "bg-dashboard-fill-strong",
      )}
      onClick={props.onClick}
      type="button"
    >
      {props.children}
      <span>{props.label}</span>
    </button>
  );
}

function ArchiveConversationButton(
  props: ConversationArchiveAction & { layout: "bar" | "menu" },
) {
  const label = props.pending
    ? "Saving archive state"
    : props.archived
      ? "Unarchive"
      : "Archive";
  const Icon = props.archived ? ArchiveRestore : Archive;
  if (props.layout === "menu") {
    return (
      <button
        aria-label={label}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-semibold text-dashboard-text transition-colors hover:bg-dashboard-fill-strong focus-visible:bg-dashboard-fill-strong focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        disabled={props.disabled}
        onClick={props.onClick}
        type="button"
      >
        <Icon aria-hidden="true" size={16} strokeWidth={2} />
        <span>{label}</span>
      </button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="hidden shrink-0 text-dashboard-text-muted md:grid"
            disabled={props.disabled}
            onClick={props.onClick}
            size="icon"
          >
            <Icon aria-hidden="true" size={15} strokeWidth={2} />
          </Button>
        }
      />
      <TooltipContent size="compact">{label}</TooltipContent>
    </Tooltip>
  );
}
