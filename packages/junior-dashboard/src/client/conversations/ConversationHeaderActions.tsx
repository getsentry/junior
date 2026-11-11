import {
  Fragment,
  useRef,
  type ComponentProps,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { Info, MessagesSquare, ScrollText, Search, X } from "lucide-react";

import { Button } from "../components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { Kbd } from "../components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { platformShortcut } from "../keyboard";
import { cn } from "../styles";
import { useTranscriptFindShortcut } from "./transcriptSearch";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import { OutboundLink } from "../components/OutboundLink";
import {
  useConversationMenuItems,
  type ConversationMenu,
  type ConversationMenuItem,
} from "./conversationMenuItems";

/**
 * Render the conversation `⋯` menu rows, with search and details there on
 * mobile too. A toggle or a row whose label shows its result keeps the menu
 * open. Every other row closes it.
 */
export function ConversationHeaderActions(props: {
  /** Turn every row off, such as before the Conversation exists. */
  disabled?: boolean;
  menu: ConversationMenu;
  onDetailsClick(): void;
  onSearchClick(): void;
  placement: "desktop" | "mobile";
  searchOpen: boolean;
}) {
  const groups = useConversationMenuItems(props.menu);
  const mobile = props.placement === "mobile";
  // Search, details, and the app menu need the page, so the sidebar row menu
  // does not show them. Every other row comes from `useConversationMenuItems`.
  return (
    <>
      {mobile && !props.menu.eventLogOpen ? (
        <DropdownMenuItem
          disabled={props.disabled}
          onClick={props.onSearchClick}
        >
          {props.searchOpen ? (
            <X aria-hidden="true" />
          ) : (
            <Search aria-hidden="true" />
          )}
          {props.searchOpen ? "Hide search" : "Search transcript"}
        </DropdownMenuItem>
      ) : null}
      {mobile ? (
        <DropdownMenuItem
          disabled={props.disabled}
          onClick={props.onDetailsClick}
        >
          <Info aria-hidden="true" />
          Conversation details
        </DropdownMenuItem>
      ) : null}
      {groups.map((items, index) => (
        <Fragment key={index}>
          {index > 0 ? <DropdownMenuSeparator /> : null}
          {items.map((item) => (
            <ConversationMenuRow
              disabled={props.disabled}
              item={item}
              key={item.key}
            />
          ))}
        </Fragment>
      ))}
    </>
  );
}

function ConversationMenuRow(props: {
  disabled?: boolean;
  item: ConversationMenuItem;
}) {
  const { item } = props;
  // A link row needs the loaded detail, so `disabled` never applies to it.
  if (item.href) {
    return (
      <DropdownMenuLinkItem render={<OutboundLink href={item.href} />}>
        <item.icon aria-hidden="true" />
        {item.label}
      </DropdownMenuLinkItem>
    );
  }
  return (
    <>
      <DropdownMenuItem
        closeOnClick={!item.stayOpen && !item.toggle}
        disabled={props.disabled || item.disabled}
        onClick={item.onClick}
      >
        <item.icon aria-hidden="true" />
        {item.label}
      </DropdownMenuItem>
      {item.feedback === undefined ? null : (
        <span className="sr-only" role="status">
          {item.feedback}
        </span>
      )}
    </>
  );
}

/** Switch between the conversation and event log. */
export function TranscriptViewToggle(props: {
  onChange(value: TranscriptViewMode): void;
  value: TranscriptViewMode;
}) {
  return (
    <ToggleGroup
      aria-label="Transcript view"
      className="inline-flex gap-0.5 rounded-md border border-dashboard-border bg-dashboard-overlay-soft p-0.5"
      onValueChange={([next]) => {
        if (next) props.onChange(next);
      }}
      value={[props.value]}
    >
      <ViewModeItem label="Conversation" value="rich">
        <MessagesSquare aria-hidden="true" size={14} strokeWidth={2} />
      </ViewModeItem>
      <ViewModeItem label="Event log" value="raw">
        <ScrollText aria-hidden="true" size={14} strokeWidth={2} />
      </ViewModeItem>
    </ToggleGroup>
  );
}

function ViewModeItem(props: {
  children: ReactNode;
  label: string;
  value: TranscriptViewMode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ToggleGroupItem
            aria-label={props.label}
            className="size-7 min-w-0 border-0 px-0 data-pressed:border-0 data-pressed:bg-dashboard-fill-hover"
            value={props.value}
          >
            {props.children}
          </ToggleGroupItem>
        }
      />
      <TooltipContent size="compact">{props.label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Shared icon control used by conversation and subagent transcript headers.
 * Other props go to the button, so a menu trigger can render it.
 */
export function HeaderIconButton({
  children,
  className,
  controls,
  expanded,
  keyShortcuts,
  label,
  pressed,
  shortcut,
  tooltipDisabled,
  ...buttonProps
}: Omit<ComponentProps<typeof Button>, "children" | "size"> & {
  children: ReactNode;
  controls?: string;
  expanded?: boolean;
  /** `aria-keyshortcuts` value for the shortcut. */
  keyShortcuts?: string;
  label: string;
  pressed?: boolean;
  ref?: Ref<HTMLButtonElement>;
  /** Shortcut text shown in the tooltip, such as `⌘F`. */
  shortcut?: string;
  /** Hide the tooltip, such as while the menu this button opens covers it. */
  tooltipDisabled?: boolean;
}) {
  return (
    <Tooltip disabled={tooltipDisabled}>
      <TooltipTrigger
        render={
          <Button
            aria-controls={controls}
            aria-expanded={expanded}
            aria-keyshortcuts={keyShortcuts}
            aria-label={label}
            aria-pressed={pressed}
            className={cn(
              "text-dashboard-text-muted data-popup-open:bg-dashboard-fill-strong data-popup-open:text-dashboard-text",
              pressed && "bg-dashboard-fill-strong text-dashboard-text",
              className,
            )}
            size="icon"
            {...buttonProps}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent size="compact">
        {label}
        {shortcut ? (
          <Kbd className="ml-1.5" variant="plain">
            {shortcut}
          </Kbd>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** Toggle transcript search with the header icon control or ⌘F / Ctrl+F. */
export function TranscriptSearchToggle(props: {
  inputRef: RefObject<HTMLInputElement | null>;
  onClick(): void;
  open: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  useTranscriptFindShortcut({
    anchorRef: buttonRef,
    inputRef: props.inputRef,
    onOpen: props.onClick,
    open: props.open,
  });
  return (
    <HeaderIconButton
      ref={buttonRef}
      keyShortcuts={props.open ? undefined : "Meta+F Control+F"}
      label={props.open ? "Hide search" : "Search transcript"}
      onClick={props.onClick}
      pressed={props.open}
      shortcut={props.open ? undefined : platformShortcut("f")}
    >
      {props.open ? (
        <X aria-hidden="true" size={15} strokeWidth={2} />
      ) : (
        <Search aria-hidden="true" size={15} strokeWidth={2} />
      )}
    </HeaderIconButton>
  );
}
