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

const SECTION_CLASS =
  "grid gap-2 border-t border-dashboard-border pt-3 text-xs";
const SECTION_TITLE_CLASS = "m-0 text-xs font-medium text-dashboard-text-muted";
const ROW_LINK_CLASS =
  "min-w-0 truncate text-sm text-dashboard-text hover:underline focus-visible:outline-dashboard-focus";

// The pull requests the person merged come first: they say more about what
// the person does than their Junior activity.
function MergedChanges(props: { changes: PersonCardReport["mergedChanges"] }) {
  if (props.changes.length === 0) return null;
  return (
    <section aria-label="Recently shipped" className={SECTION_CLASS}>
      <p className={SECTION_TITLE_CLASS}>Recently shipped</p>
      <ul className="m-0 grid list-none gap-2 p-0">
        {props.changes.map((change) => {
          const at = change.mergedAt ?? change.openedAt;
          const title = change.title ?? `#${change.number}`;
          return (
            // The title gets the whole first line. The pull request and
            // when it merged go below it.
            <li key={change.id} className="grid min-w-0">
              {change.url ? (
                <a
                  className={ROW_LINK_CLASS}
                  href={change.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {title}
                </a>
              ) : (
                <span className="min-w-0 truncate text-sm">{title}</span>
              )}
              <span className="min-w-0 truncate text-dashboard-text-muted">
                {change.repository}#{change.number} ·{" "}
                <time dateTime={at} title={formatTime(at)}>
                  merged {formatRelativeTime(at)}
                </time>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PersonActivity(props: { activity: PersonCardReport["activity"] }) {
  const { activity } = props;
  return (
    <section aria-label="Recent activity" className={SECTION_CLASS}>
      <p className={SECTION_TITLE_CLASS}>
        {activity.lastActiveAt ? (
          <>
            Last active on Junior{" "}
            <time
              dateTime={activity.lastActiveAt}
              title={formatTime(activity.lastActiveAt)}
            >
              {formatRelativeTime(activity.lastActiveAt)}
            </time>
          </>
        ) : (
          "No recent activity on Junior"
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
                className={ROW_LINK_CLASS}
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
 * their People page shows, the pull requests they merged most recently, and
 * their recent activity in the Conversations the viewer may read. It loads when it opens. `actions` holds buttons for
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
        {email !== undefined && isPending ? (
          <p className="m-0 text-xs text-dashboard-text-muted">
            Loading recent activity…
          </p>
        ) : null}
        {data ? (
          <>
            <MergedChanges changes={data.mergedChanges} />
            <PersonActivity activity={data.activity} />
          </>
        ) : null}
        {props.actions ? (
          <div className="flex flex-wrap gap-2">{props.actions}</div>
        ) : null}
      </ObjectCard>
    </div>
  );
}
