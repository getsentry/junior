import { Link } from "react-router";

import {
  conversationDisplayTitle,
  conversationActorLabel,
  locationPath,
  peoplePath,
  slackLocationLabel,
} from "../format";
import type { Conversation } from "../types";
import { cn } from "../styles";

/** Render the shared conversation title and identity. */
export function ConversationSummary(props: { conversation: Conversation }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 truncate text-base font-bold leading-tight text-dashboard-text">
          {conversationDisplayTitle(props.conversation)}
        </div>
        <PullRequestBadge conversation={props.conversation} />
      </div>
      <div className="mt-1 break-words text-sm leading-relaxed text-dashboard-text-muted md:truncate">
        <ConversationIdentity conversation={props.conversation} />
      </div>
    </div>
  );
}

function PullRequestBadge(props: { conversation: Conversation }) {
  const pullRequest = props.conversation.pullRequest;
  if (!pullRequest) return null;
  const label =
    pullRequest.status === "draft"
      ? "PR draft"
      : pullRequest.status === "open"
        ? "PR ready"
        : "PR merged";
  return (
    <a
      aria-label={`${pullRequest.label}: ${label}`}
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 font-mono text-xs font-bold uppercase tracking-wide",
        pullRequest.status === "draft" &&
          "border-amber-300/35 bg-amber-300/10 text-amber-200",
        pullRequest.status === "open" &&
          "border-cyan-300/35 bg-cyan-300/10 text-cyan-200",
        pullRequest.status === "merged" &&
          "border-violet-300/35 bg-violet-300/10 text-violet-200",
      )}
      href={pullRequest.url}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      rel="noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
}

function ConversationIdentity(props: { conversation: Conversation }) {
  const email = props.conversation.actorIdentity?.email?.trim();
  const owner = conversationActorLabel(props.conversation);
  const id = props.conversation.id;
  const location = slackLocationLabel(props.conversation, {
    includeId: false,
  });

  return (
    <>
      {location && props.conversation.locationId ? (
        <>
          <Link
            className="font-semibold text-dashboard-text underline decoration-white/20 underline-offset-2 transition-colors hover:text-dashboard-text hover:decoration-white/60"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            to={locationPath(props.conversation.locationId)}
          >
            {location}
          </Link>
          {" · "}
        </>
      ) : location ? (
        <>
          {location}
          {" · "}
        </>
      ) : null}
      {email ? (
        <Link
          className="font-semibold text-dashboard-text underline decoration-white/20 underline-offset-2 transition-colors hover:text-dashboard-text hover:decoration-white/60"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          to={peoplePath(email)}
        >
          {owner}
        </Link>
      ) : owner ? (
        owner
      ) : null}
      {owner ? " · " : null}
      {id}
    </>
  );
}
