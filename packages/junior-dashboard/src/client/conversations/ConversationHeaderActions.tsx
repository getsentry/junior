import type { ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  Info,
  MessagesSquare,
  ScrollText,
  Search,
  X,
} from "lucide-react";

import { Button, ToggleButton } from "../components/Button";
import { IconButtonTooltip } from "../components/Tooltip";
import { cn } from "../styles";
import type { TranscriptViewMode } from "./transcriptRenderModel";

export type ConversationArchiveAction = {
  archived: boolean;
  disabled: boolean;
  error: boolean;
  onClick(): void;
  pending: boolean;
};

/** Render the compact icon controls for one conversation header. */
export function ConversationHeaderActions(props: {
  archive: ConversationArchiveAction;
  copyAction?: ReactNode;
  detailsOpen: boolean;
  onDetailsClick(): void;
  onSearchClick(): void;
  onViewChange(value: TranscriptViewMode): void;
  searchOpen: boolean;
  view: TranscriptViewMode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <TranscriptSearchToggle
        onClick={props.onSearchClick}
        open={props.searchOpen}
      />
      <TranscriptViewToggle onChange={props.onViewChange} value={props.view} />
      {props.copyAction}
      <ArchiveConversationButton {...props.archive} />
      <HeaderIconButton
        label="Conversation details"
        onClick={props.onDetailsClick}
        pressed={props.detailsOpen}
      >
        <Info aria-hidden="true" size={15} strokeWidth={2} />
      </HeaderIconButton>
    </div>
  );
}

/** Icon-only conversation / event-log toggle shared by transcript surfaces. */
export function TranscriptViewToggle(props: {
  onChange(value: TranscriptViewMode): void;
  value: TranscriptViewMode;
}) {
  return (
    <div
      aria-label="Transcript view"
      className="inline-flex items-center gap-0.5 rounded-md border border-white/[0.08] bg-black/20 p-0.5"
      role="group"
    >
      <ViewModeButton
        active={props.value === "rich"}
        label="Conversation"
        onClick={() => props.onChange("rich")}
      >
        <MessagesSquare aria-hidden="true" size={14} strokeWidth={2} />
      </ViewModeButton>
      <ViewModeButton
        active={props.value === "raw"}
        label="Event log"
        onClick={() => props.onChange("raw")}
      >
        <ScrollText aria-hidden="true" size={14} strokeWidth={2} />
      </ViewModeButton>
    </div>
  );
}

function ViewModeButton(props: {
  active: boolean;
  children: ReactNode;
  label: string;
  onClick(): void;
}) {
  return (
    <IconButtonTooltip label={props.label}>
      <ToggleButton
        aria-label={props.label}
        className={cn(
          "!normal-case !no-underline grid size-7 place-items-center rounded px-0 py-0",
          props.active
            ? "bg-white/[0.08] text-dashboard-text"
            : "text-dashboard-text-muted",
        )}
        onClick={props.onClick}
        pressed={props.active}
        variant="text"
      >
        {props.children}
      </ToggleButton>
    </IconButtonTooltip>
  );
}

/** Shared icon control used by conversation and subagent transcript headers. */
export function HeaderIconButton(props: {
  children: ReactNode;
  label: string;
  onClick(): void;
  pressed?: boolean;
}) {
  return (
    <IconButtonTooltip label={props.label}>
      <Button
        aria-label={props.label}
        aria-pressed={props.pressed}
        className={cn(
          "text-dashboard-text-muted",
          props.pressed && "bg-white/10 text-dashboard-text",
        )}
        onClick={props.onClick}
        size="icon"
      >
        {props.children}
      </Button>
    </IconButtonTooltip>
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

function ArchiveConversationButton(props: ConversationArchiveAction) {
  const label = props.pending
    ? "Saving archive state"
    : props.archived
      ? "Unarchive"
      : "Archive";
  const Icon = props.archived ? ArchiveRestore : Archive;
  return (
    <IconButtonTooltip label={label}>
      <Button
        aria-label={label}
        className="hidden shrink-0 text-dashboard-text-muted md:grid"
        disabled={props.disabled}
        onClick={props.onClick}
        size="icon"
      >
        <Icon aria-hidden="true" size={15} strokeWidth={2} />
      </Button>
    </IconButtonTooltip>
  );
}
