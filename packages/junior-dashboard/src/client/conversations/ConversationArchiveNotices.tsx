import { useEffect } from "react";
import { ArchiveRestore, CircleAlert } from "lucide-react";

import { Notice, NoticeAction } from "../components/Notice";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { conversationDisplayTitle } from "../format";
import { useArchiveConversation } from "./queries";

/** Show archive errors and the most recent reversible archive action. */
export function ConversationArchiveNotices(props: {
  archivedConversation?: Conversation;
  archiveError?: { conversation: Conversation; wasArchiving: boolean };
  className?: string;
  onDismissError(): void;
  onRestored(): void;
}) {
  if (!props.archivedConversation && !props.archiveError) return null;
  return (
    <div className={cn("grid gap-2", props.className)}>
      {props.archiveError ? (
        <ArchiveErrorNotice
          conversation={props.archiveError.conversation}
          onDismiss={props.onDismissError}
          wasArchiving={props.archiveError.wasArchiving}
        />
      ) : null}
      {props.archivedConversation ? (
        <ArchivedNotice
          conversation={props.archivedConversation}
          key={props.archivedConversation.id}
          onRestored={props.onRestored}
        />
      ) : null}
    </div>
  );
}

function ArchiveErrorNotice(props: {
  conversation: Conversation;
  onDismiss(): void;
  wasArchiving: boolean;
}) {
  const title = conversationDisplayTitle(props.conversation);
  return (
    <Notice
      action={
        <NoticeAction onClick={props.onDismiss} title="Dismiss" tone="error">
          Dismiss
        </NoticeAction>
      }
      detail={title}
      icon={CircleAlert}
      title={props.wasArchiving ? "Could not archive" : "Could not restore"}
      tone="error"
    />
  );
}

function ArchivedNotice(props: {
  conversation: Conversation;
  onRestored(): void;
}) {
  const restore = useArchiveConversation(props.conversation.id, {
    onSuccess: (archived) => {
      if (!archived) props.onRestored();
    },
  });
  const title = conversationDisplayTitle(props.conversation);

  useEffect(() => {
    if (restore.isPending || restore.error) return;
    const timeout = window.setTimeout(props.onRestored, 6_000);
    return () => window.clearTimeout(timeout);
  }, [
    props.conversation.id,
    props.onRestored,
    restore.error,
    restore.isPending,
  ]);

  return (
    <Notice
      action={
        <NoticeAction
          aria-label={`Undo archive for ${title}`}
          disabled={restore.isPending}
          onClick={() =>
            restore.mutate({
              archived: false,
              lastSeenAt: props.conversation.lastSeenAt,
            })
          }
          title={`Undo archive for ${title}`}
        >
          {restore.isPending ? "Restoring…" : "Undo"}
        </NoticeAction>
      }
      detail={title}
      icon={ArchiveRestore}
      title="Conversation archived"
    >
      {restore.error ? (
        <div
          className="border-t border-rose-300/25 bg-rose-400/[0.12] px-3 py-2 font-mono text-xs text-rose-50/85"
          role="alert"
        >
          Could not restore the conversation.
        </div>
      ) : null}
    </Notice>
  );
}
