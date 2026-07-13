import { Link } from "react-router";

import {
  conversationDisplayTitle,
  conversationActorLabel,
  locationPath,
  peoplePath,
  slackLocationLabel,
  visualStatusForConversation,
} from "../format";
import type { Conversation } from "../types";
import { StatusBadge } from "./StatusBadge";

/** Render the shared conversation title, identity, and status. */
export function ConversationSummary(props: { conversation: Conversation }) {
  const visualStatus = visualStatusForConversation(props.conversation);

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-0 truncate text-[1.04rem] font-bold leading-tight text-white">
          {conversationDisplayTitle(props.conversation)}
        </div>
        <StatusBadge status={visualStatus} />
      </div>
      <div className="mt-1 break-words text-[0.86rem] leading-relaxed text-[#b8b8b8] md:truncate">
        <ConversationIdentity conversation={props.conversation} />
      </div>
    </div>
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
            className="font-semibold text-[#d6d6d6] underline decoration-white/20 underline-offset-2 transition-colors hover:text-white hover:decoration-white/60"
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
          className="font-semibold text-[#d6d6d6] underline decoration-white/20 underline-offset-2 transition-colors hover:text-white hover:decoration-white/60"
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
