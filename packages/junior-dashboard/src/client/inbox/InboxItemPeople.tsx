import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { PersonReference } from "../components/PersonReference";
import { MentionText } from "../display-text/DisplayText";
import { personFromUser } from "../person";

/**
 * Show an item's title with the people it mentions. Titles sit in links and
 * buttons, so mentions open no card unless `links` is set.
 */
export function InboxItemTitle(props: {
  item: Pick<InboxItemPayload, "mentions" | "title">;
  links?: boolean;
}) {
  return (
    <MentionText
      links={props.links ?? false}
      mentions={props.item.mentions}
      text={props.item.title}
    />
  );
}

/** Name the person who closed an item, or "An agent" when none did. */
export function InboxItemCloser(props: {
  card?: boolean;
  item: InboxItemPayload;
}) {
  const { closedBy } = props.item;
  return closedBy ? (
    <PersonReference card={props.card} person={personFromUser(closedBy)} />
  ) : (
    "An agent"
  );
}
