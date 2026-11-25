import type { InboxItemPayload } from "@sentry/junior/api/schema";
import { Fragment } from "react";

import { PersonReference } from "../components/PersonReference";
import { MentionText } from "../display-text/DisplayText";
import { personFromUser } from "../person";

/**
 * Show an item's title with the people it mentions. Titles sit in links and
 * buttons, so mentions open no card unless `links` is set.
 */
export function InboxItemTitle(props: {
  item: InboxItemPayload;
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

/**
 * Name the assignees of an item as people: Everyone first, then each User.
 * The server sends an item with no assignees as one for Everyone.
 */
export function InboxItemAssignees(props: {
  card?: boolean;
  item: InboxItemPayload;
}) {
  const { item } = props;
  return (
    <>
      {item.assignedToEveryone ? "Everyone" : null}
      {item.assignees.map((assignee, index) => (
        <Fragment key={assignee.userId}>
          {index > 0 || item.assignedToEveryone ? ", " : null}
          <PersonReference
            card={props.card}
            person={personFromUser(assignee)}
          />
        </Fragment>
      ))}
    </>
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
