import { useRef, type ReactNode, type Ref, type RefObject } from "react";
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  Info,
  Mail,
  MailOpen,
  MessageSquareShare,
  MessagesSquare,
  PictureInPicture2,
  Pin,
  PinOff,
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
import { ShareConversationButton } from "./ShareConversationButton";
import { useOpenConversationPopOut } from "./ConversationPopOut";
import { OutboundLink } from "../components/OutboundLink";

export type ConversationArchiveAction = {
  archived: boolean;
  disabled: boolean;
  /** The message to show when the last archive change failed. */
  error?: string;
  onClick(): void;
  pending: boolean;
};

export type ConversationContinueInSlackAction = {
  disabled: boolean;
  onClick(): void;
};

export type ConversationPinAction = {
  disabled: boolean;
  error: boolean;
  onClick(): void;
  pinned: boolean;
};

export type ConversationSubscriptionAction = {
  disabled: boolean;
  error: boolean;
  onClick(): void;
  subscribed: boolean;
};

export type ConversationReadAction = {
  disabled: boolean;
  error: boolean;
  onClick(): void;
  unread: boolean;
};

/**
 * Keep secondary conversation actions in the menu, with search and details
 * available there on mobile too.
 */
export function ConversationHeaderActions(props: {
  archive: ConversationArchiveAction;
  pin: ConversationPinAction;
  read: ConversationReadAction;
  subscription: ConversationSubscriptionAction;
  conversationId: string;
  /** Present only when the viewer can move this conversation to Slack. */
  continueInSlack?: ConversationContinueInSlackAction;
  copyAction?: ReactNode;
  detailsOpen: boolean;
  onDetailsClick(): void;
  onSearchClick(): void;
  onViewChange(value: TranscriptViewMode): void;
  placement: "desktop" | "mobile";
  searchOpen: boolean;
  sentryConversationUrl?: string;
  view: TranscriptViewMode;
}) {
  const mobile = props.placement === "mobile";
  const eventLogOpen = props.view === "raw";
  const openPopOut = useOpenConversationPopOut();
  return (
    <div className="grid gap-0.5">
      {mobile && !eventLogOpen ? (
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
      {mobile ? (
        <MenuActionButton
          label="Conversation details"
          onClick={props.onDetailsClick}
          pressed={props.detailsOpen}
        >
          <Info aria-hidden="true" size={16} strokeWidth={2} />
        </MenuActionButton>
      ) : null}
      {/* The copy action is a sibling keyed by the same id. Unique keys keep
          React from duplicating menu rows on re-render. */}
      <ShareConversationButton
        key={`share:${props.conversationId}`}
        conversationId={props.conversationId}
      />
      {props.copyAction}
      {props.continueInSlack ? (
        <MenuActionButton
          disabled={props.continueInSlack.disabled}
          label="Continue in Slack"
          onClick={props.continueInSlack.onClick}
        >
          <MessageSquareShare aria-hidden="true" size={16} strokeWidth={2} />
        </MenuActionButton>
      ) : null}
      {openPopOut && !mobile ? (
        <MenuActionButton
          label="Pop out"
          onClick={() => void openPopOut(props.conversationId)}
        >
          <PictureInPicture2 aria-hidden="true" size={16} strokeWidth={2} />
        </MenuActionButton>
      ) : null}
      <MenuActionButton
        label={eventLogOpen ? "Back to conversation" : "Open event log"}
        onClick={() => props.onViewChange(eventLogOpen ? "rich" : "raw")}
      >
        {eventLogOpen ? (
          <MessagesSquare aria-hidden="true" size={16} strokeWidth={2} />
        ) : (
          <ScrollText aria-hidden="true" size={16} strokeWidth={2} />
        )}
      </MenuActionButton>
      {props.sentryConversationUrl ? (
        <OutboundLink
          className={buttonVariants({ size: "menu" })}
          href={props.sentryConversationUrl}
        >
          <SentryGlyph />
          Open in Sentry
        </OutboundLink>
      ) : null}
      <Separator className="my-1 bg-dashboard-border-subtle" />
      <MenuActionButton
        disabled={props.read.disabled}
        label={props.read.unread ? "Mark as read" : "Mark as unread"}
        onClick={props.read.onClick}
      >
        {props.read.unread ? (
          <MailOpen aria-hidden="true" size={16} strokeWidth={2} />
        ) : (
          <Mail aria-hidden="true" size={16} strokeWidth={2} />
        )}
      </MenuActionButton>
      <MenuActionButton
        disabled={props.pin.disabled}
        label={props.pin.pinned ? "Unpin" : "Pin"}
        onClick={props.pin.onClick}
      >
        {props.pin.pinned ? (
          <PinOff aria-hidden="true" size={16} strokeWidth={2} />
        ) : (
          <Pin aria-hidden="true" size={16} strokeWidth={2} />
        )}
      </MenuActionButton>
      <MenuActionButton
        disabled={props.subscription.disabled}
        label={props.subscription.subscribed ? "Unsubscribe" : "Subscribe"}
        onClick={props.subscription.onClick}
      >
        {props.subscription.subscribed ? (
          <BellOff aria-hidden="true" size={16} strokeWidth={2} />
        ) : (
          <Bell aria-hidden="true" size={16} strokeWidth={2} />
        )}
      </MenuActionButton>
      <ArchiveConversationButton {...props.archive} />
    </div>
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
    </Button>
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
    <Button
      aria-label={label}
      disabled={props.disabled}
      onClick={props.onClick}
      size="menu"
    >
      <Icon aria-hidden="true" size={16} strokeWidth={2} />
      <span>{label}</span>
    </Button>
  );
}

/** Draw the Sentry glyph in the current text color, sized like a menu icon. */
function SentryGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z" />
    </svg>
  );
}
