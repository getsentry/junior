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
        <MenuActionButton
          label={props.searchOpen ? "Hide search" : "Search transcript"}
          onClick={props.onSearchClick}
        >
          {props.searchOpen ? (
            <X aria-hidden="true" size={16} strokeWidth={2} />
          ) : (
            <Search aria-hidden="true" size={16} strokeWidth={2} />
          )}
        </MenuActionButton>
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
      <TranscriptSearchToggle
        onClick={props.onSearchClick}
        open={props.searchOpen}
      />
      <TranscriptViewToggle onChange={props.onViewChange} value={props.view} />
      {props.copyAction}
      <ArchiveConversationButton {...props.archive} layout="bar" />
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
        "flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-semibold text-dashboard-text transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none",
        props.pressed && "bg-white/[0.08]",
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
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-semibold text-dashboard-text transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
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
