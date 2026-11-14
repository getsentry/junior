import type { ClipboardEventHandler, ReactNode } from "react";
import { Bot } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Message, MessageContent } from "../components/ui/message";
import { transcriptRoleKind } from "../format";
import { cn } from "../styles";
import juniorAvatarUrl from "../../assets/junior-avatar.webp";
import {
  transcriptAvatarClass,
  transcriptColumnsClass,
} from "./TranscriptRows";

/** Align message text and attachments beside their avatars. */
export function TranscriptMessageShell(props: {
  actor: string;
  /** Junior API path of the author photo. Initials show without it. */
  avatarUrl?: string | undefined;
  children: ReactNode;
  /** The parent agent wrote this input, so it shows an agent, not a person. */
  fromAgent?: boolean;
  onCopy?: ClipboardEventHandler<HTMLElement>;
  role: string;
}) {
  const kind = transcriptRoleKind(props.role);
  const hasAvatar = kind === "assistant" || kind === "user";
  return (
    <Message
      className={cn(
        hasAvatar && cn(transcriptColumnsClass, "text-dashboard-text"),
        kind === "system" &&
          "rounded-xl bg-dashboard-surface-panel px-4 py-3 text-dashboard-text max-md:ml-4",
        kind === "tool" &&
          "rounded-none px-0 text-dashboard-text-muted max-md:ml-8",
        kind === "other" &&
          "bg-dashboard-surface-hover text-dashboard-text max-md:ml-8",
      )}
      onCopy={props.onCopy}
    >
      {hasAvatar ? (
        <div
          aria-hidden="true"
          className={cn(
            "flex items-center justify-center",
            transcriptAvatarClass,
          )}
        >
          {kind === "assistant" ? (
            <img
              alt=""
              className="size-full object-contain"
              draggable={false}
              src={juniorAvatarUrl}
            />
          ) : props.fromAgent ? (
            <span className="grid size-full place-items-center rounded-full bg-dashboard-surface-hover text-cyan-200">
              <Bot size={15} strokeWidth={2} />
            </span>
          ) : (
            <Avatar className="size-full border-0 bg-violet-300 shadow-none">
              <AvatarImage
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                src={props.avatarUrl}
              />
              <AvatarFallback>
                {props.actor
                  .split(/\s+/)
                  .map((word) => word[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}
        </div>
      ) : null}
      <MessageContent className="py-1">{props.children}</MessageContent>
    </Message>
  );
}
