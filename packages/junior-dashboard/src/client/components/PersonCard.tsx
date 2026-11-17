import {
  personCardReportSchema,
  type OwnedObjectAnnotation,
  type PersonCardReport,
} from "@sentry/junior/api/schema";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { conversationPath } from "../conversations/conversationRoutes";
import { ObjectCard } from "../conversations/ObjectCard";
import { peoplePath } from "../format";
import { fetchDashboardJson } from "../http";
import type { Person } from "../person";
import { formatRelativeTime, formatTime } from "../time";

// What the reference already knows, until the person card loads, and for a
// person Junior has no page for.
function referenceCard(person: Person): OwnedObjectAnnotation {
  return {
    facts: {
      type: "person",
      ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : undefined),
    },
    key: person.email ?? person.name,
    kind: "object",
    label: person.name,
    objectType: "person",
    plugin: "junior",
    title: person.name,
    url: person.email ? peoplePath(person.email) : null,
  };
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;
}

function PersonActivity(props: {
  activity: PersonCardReport["activity"] | undefined;
  loading: boolean;
}) {
  const { activity } = props;
  if (!activity) {
    return props.loading ? (
      <p className="m-0 text-xs text-dashboard-text-muted">
        Loading recent activity…
      </p>
    ) : null;
  }
  return (
    <section
      aria-label="Recent activity"
      className="grid gap-2 border-t border-dashboard-border pt-3 text-xs"
    >
      <p className="m-0 text-dashboard-text-muted">
        {activity.lastActiveAt ? (
          <>
            Last active{" "}
            <time
              dateTime={activity.lastActiveAt}
              title={formatTime(activity.lastActiveAt)}
            >
              {formatRelativeTime(activity.lastActiveAt)}
            </time>
            {" · "}
            {count(activity.turns, "turn")} in{" "}
            {count(activity.conversations, "conversation")} this week
          </>
        ) : (
          "No recent activity"
        )}
      </p>
      {activity.recentConversations.length > 0 && (
        <ul className="m-0 grid list-none gap-1 p-0">
          {activity.recentConversations.map((item) => (
            <li
              key={item.conversationId}
              className="flex min-w-0 items-baseline gap-2"
            >
              <Link
                className="min-w-0 truncate text-sm text-dashboard-text hover:underline focus-visible:outline-dashboard-focus"
                to={conversationPath(item.conversationId)}
              >
                {item.title}
              </Link>
              <time
                className="shrink-0 text-dashboard-text-muted"
                dateTime={item.lastTurnAt}
                title={formatTime(item.lastTurnAt)}
              >
                {formatRelativeTime(item.lastTurnAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The card of one person: their person object card, the same one a link to
 * their People page shows, and their recent activity in the Conversations
 * the viewer may read. It loads when it opens. `actions` holds buttons for
 * this person, such as an invite.
 */
export function PersonCard(props: { actions?: ReactNode; person: Person }) {
  const email = props.person.email?.toLowerCase();
  const { data, isPending } = useQuery({
    queryKey: ["person-card", email],
    queryFn: () =>
      fetchDashboardJson(
        personCardReportSchema,
        `/api/people/${encodeURIComponent(email!)}/card`,
      ),
    enabled: email !== undefined,
    // The API caches a card for a minute too.
    staleTime: 60_000,
    retry: false,
  });
  return (
    <div aria-label={props.person.name} className="grid" role="dialog">
      <ObjectCard
        card={data?.card ?? referenceCard(props.person)}
        className="my-0 rounded-none border-0"
        live
      >
        {email !== undefined && (
          <PersonActivity activity={data?.activity} loading={isPending} />
        )}
        {props.actions ? (
          <div className="flex flex-wrap gap-2">{props.actions}</div>
        ) : null}
      </ObjectCard>
    </div>
  );
}
