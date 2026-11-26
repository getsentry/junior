import { createContext, useState } from "react";

import type { MentionablePerson } from "@sentry/junior/api/schema";
import { PersonCard } from "../components/PersonCard";
import { HoverPreview } from "../components/ui/hover-preview";
import { personFromActor } from "../person";
import { mentionName } from "./composerMentionToken";

/**
 * The Conversation that a composer writes to. The `@` menu finds people of
 * its Slack workspace.
 */
export type ComposerConversation = { conversationId: string };

/** Give the `@` menu and mention cards of one composer their Conversation. */
export const ComposerConversationContext = createContext<
  ComposerConversation | undefined
>(undefined);

/**
 * A person mentioned in the composer: their photo and name. Hover, focus,
 * or a tap shows their person card. A person whose name the composer does
 * not know shows their Slack id and no card.
 */
export function ComposerMention(props: {
  person: Partial<MentionablePerson> & { slackUserId: string };
}) {
  const { person } = props;
  const card = personFromActor(person);
  const chip = (
    <>
      {person.avatarUrl ? <MentionPhoto src={person.avatarUrl} /> : null}@
      {mentionName(person)}
    </>
  );
  const chipProps = {
    className:
      "cursor-pointer rounded-sm font-medium whitespace-nowrap text-dashboard-accent-text hover:bg-dashboard-accent/15",
    "data-mention": person.slackUserId,
  };
  if (!card) return <span {...chipProps}>{chip}</span>;
  return (
    <HoverPreview
      content={<PersonCard person={card} />}
      tapToOpen
      trigger={<span {...chipProps} role="button" tabIndex={-1} />}
    >
      {chip}
    </HoverPreview>
  );
}

// Like a transcript mention: a photo at text height. A photo that fails to
// load does not render.
function MentionPhoto(props: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      alt=""
      className="mr-1 inline-block size-[1em] rounded-full object-cover align-[-0.125em]"
      onError={() => setFailed(true)}
      src={props.src}
    />
  );
}
