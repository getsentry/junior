import {
  Fragment,
  useRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  Info,
  Maximize2,
  MessagesSquare,
  ScrollText,
  Search,
  X,
} from "lucide-react";

import { Button, buttonVariants } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
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
 * open. Every other row closes it before it acts.
 */
export function ConversationHeaderActions(props: {
  close(): void;
  detailsOpen: boolean;
  menu: ConversationMenu;
  onDetailsClick(): void;
  onSearchClick(): void;
  placement: "desktop" | "mobile";
  searchOpen: boolean;
  /** Present on desktop, where Zen mode exists. */
  zen?: { active: boolean; onToggle(): void; shortcut: string };
}) {
  const groups = useConversationMenuItems(props.menu);
  const { zen } = props;
  const mobile = props.placement === "mobile";
  // Search, details, and the app menu need the page, so the sidebar row menu
  // does not show them. Every other row comes from `useConversationMenuItems`.
  return (
    <div className="grid gap-0.5">
      {!props.menu.eventLogOpen ? (
        <MenuActionButton
          label={props.searchOpen ? "Hide search" : "Search transcript"}
          onClick={() => {
            props.close();
            props.onSearchClick();
          }}
          pressed={props.searchOpen}
        >
          {props.searchOpen ? (
            <X aria-hidden="true" size={16} strokeWidth={2} />
          ) : (
            <Search aria-hidden="true" size={16} strokeWidth={2} />
          )}
        </MenuActionButton>
      ) : null}
      {zen ? (
        <MenuActionButton
          label="Zen mode"
          onClick={() => {
            props.close();
            zen.onToggle();
          }}
          pressed={zen.active}
          shortcut={zen.shortcut}
        >
          <Maximize2 aria-hidden="true" size={16} strokeWidth={2} />
        </MenuActionButton>
      ) : null}
      {mobile ? (
        <MenuActionButton
          label="Conversation details"
          onClick={() => {
            props.close();
            props.onDetailsClick();
          }}
          pressed={props.detailsOpen}
        >
          <Info aria-hidden="true" size={16} strokeWidth={2} />
        </MenuActionButton>
      ) : null}
      {groups.map((items, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <Separator className="my-1 bg-dashboard-border-subtle" />
          ) : null}
          {items.map((item) => (
            <ConversationMenuRow
              close={props.close}
              item={item}
              key={item.key}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}

function ConversationMenuRow(props: {
  close(): void;
  item: ConversationMenuItem;
}) {
  const { item } = props;
  const icon = <item.icon aria-hidden="true" className="size-4 shrink-0" />;
  if (item.href) {
    return (
      <OutboundLink
        className={buttonVariants({ size: "menu" })}
        href={item.href}
      >
        {icon}
        {item.label}
      </OutboundLink>
    );
  }
  return (
    <>
      <Button
        aria-label={item.label}
        disabled={item.disabled}
        focusableWhenDisabled={item.stayOpen || item.toggle}
        onClick={() => {
          if (!item.stayOpen && !item.toggle) props.close();
          item.onClick?.();
        }}
        size="menu"
      >
        {icon}
        <span>{item.label}</span>
      </Button>
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

/** Shared icon control used by conversation and subagent transcript headers. */
export function HeaderIconButton(props: {
  children: ReactNode;
  controls?: string;
  expanded?: boolean;
  /** `aria-keyshortcuts` value for the shortcut. */
  keyShortcuts?: string;
  ref?: Ref<HTMLButtonElement>;
  label: string;
  onClick(): void;
  pressed?: boolean;
  /** Shortcut text shown in the tooltip, such as `⌘F`. */
  shortcut?: string;
  /** Hide the tooltip, such as while the menu this button opens covers it. */
  tooltipDisabled?: boolean;
}) {
  return (
    <Tooltip disabled={props.tooltipDisabled}>
      <TooltipTrigger
        render={
          <Button
            ref={props.ref}
            aria-controls={props.controls}
            aria-expanded={props.expanded}
            aria-keyshortcuts={props.keyShortcuts}
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
      <TooltipContent size="compact">
        {props.label}
        {props.shortcut ? (
          <kbd className="ml-1.5 font-sans">{props.shortcut}</kbd>
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

function MenuActionButton(props: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick(): void;
  pressed?: boolean;
  /** Keycap text for the row's shortcut, such as `⌥⌘Y`. */
  shortcut?: string;
}) {
  return (
    <Button
      aria-label={props.label}
      aria-pressed={props.pressed}
      className={props.pressed ? "bg-dashboard-fill-strong" : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
      size="menu"
    >
      {props.children}
      <span>{props.label}</span>
      {props.shortcut ? (
        <kbd className="ml-auto rounded border border-dashboard-border px-1.5 py-0.5 font-sans text-2xs text-dashboard-text-faint">
          {props.shortcut}
        </kbd>
      ) : null}
    </Button>
  );
}
