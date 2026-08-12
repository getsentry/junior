import { Link } from "react-router";

import {
  conversationDisplayTitle,
  conversationActorLabel,
  locationPath,
  peoplePath,
  slackLocationLabel,
} from "../format";
import type { Conversation } from "../types";

/** Render the shared conversation title and identity. */
export function ConversationSummary(props: { conversation: Conversation }) {
  return (
    <div className="min-w-0">
      <div className="min-w-0 truncate text-base font-bold leading-tight text-dashboard-text">
        {conversationDisplayTitle(props.conversation)}
      </div>
      <div className="mt-1 break-words text-sm leading-relaxed text-dashboard-text-muted md:truncate">
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
            className="font-semibold text-dashboard-text underline decoration-dashboard-decoration underline-offset-2 transition-colors hover:text-dashboard-text hover:decoration-dashboard-decoration-strong"
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
          className="font-semibold text-dashboard-text underline decoration-dashboard-decoration underline-offset-2 transition-colors hover:text-dashboard-text hover:decoration-dashboard-decoration-strong"
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
