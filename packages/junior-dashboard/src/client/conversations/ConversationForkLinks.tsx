import { GitFork } from "lucide-react";
import { Link } from "react-router";
import { conversationPath } from "./conversationRoutes";

const linkClassName =
  "font-medium text-dashboard-text no-underline underline-offset-2 hover:underline";

/** Link a conversation to its fork source and to its forks. */
export function ConversationForkLinks(props: {
  forkedFromConversationId?: string;
  forks?: string[];
}) {
  return (
    <nav
      aria-label="Conversation forks"
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-snug text-dashboard-text-muted"
    >
      <GitFork aria-hidden="true" size={12} className="shrink-0" />
      {props.forkedFromConversationId ? (
        <span>
          Forked from{" "}
          <Link
            aria-label="Forked from source conversation"
            className={linkClassName}
            to={conversationPath(props.forkedFromConversationId)}
          >
            source conversation
          </Link>
        </span>
      ) : null}
      {props.forkedFromConversationId && props.forks?.length ? (
        <span>·</span>
      ) : null}
      {props.forks?.length ? (
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          Forks:
          {props.forks.map((id, index) => (
            <Link
              key={id}
              aria-label={`Fork ${index + 1}`}
              className={linkClassName}
              to={conversationPath(id)}
            >
              {index + 1}
            </Link>
          ))}
        </span>
      ) : null}
    </nav>
  );
}
