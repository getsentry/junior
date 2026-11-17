import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { useDashboardCoreData } from "../api";
import { peoplePath } from "../format";
import type { Person } from "../person";
import { cn } from "../styles";
import { HoverPreview } from "./ui/hover-preview";
import { PersonCard } from "./PersonCard";

function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

// A photo that fails to load shows the initial, so every person has a mark.
function PersonPhoto(props: {
  className: string;
  initialClassName?: string;
  person: Person;
}) {
  const [failed, setFailed] = useState(false);
  if (props.person.avatarUrl && !failed) {
    return (
      <img
        alt=""
        className={cn("rounded-full object-cover", props.className)}
        loading="lazy"
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
        src={props.person.avatarUrl}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid place-items-center rounded-full bg-ring font-sans font-semibold leading-none text-primary-foreground",
        props.className,
      )}
    >
      <span className={props.initialClassName}>
        {initial(props.person.name)}
      </span>
    </span>
  );
}

/**
 * Show one person in running text the way GitHub shows a mention: a small
 * round photo at text height, then the name. With `highlightSelf`, a
 * mention of the viewer gets a subtle highlight and `data-self-mention`.
 */
export function PersonInline(props: {
  avatar?: boolean | undefined;
  children: ReactNode;
  highlightSelf?: boolean | undefined;
  person: Person;
}) {
  const viewer = useDashboardCoreData().data?.me.user.email;
  const self = Boolean(
    props.highlightSelf &&
    viewer &&
    props.person.email?.toLowerCase() === viewer.toLowerCase(),
  );
  return (
    <span
      className={cn(
        "whitespace-nowrap",
        self && "rounded-sm bg-dashboard-accent/15 px-0.5",
      )}
      data-self-mention={self ? "" : undefined}
    >
      {props.avatar === false ? null : (
        <PersonPhoto
          className="mr-1 inline-grid size-[1em] align-[-0.125em]"
          initialClassName="text-[0.6em]"
          person={props.person}
        />
      )}
      {props.children}
    </span>
  );
}

// A name reads as plain text until the reader hovers it.
const NAME_CLASS = "text-inherit no-underline hover:underline";

const TRIGGER_CLASS =
  "cursor-pointer rounded-sm border-0 bg-transparent p-0 text-left [font:inherit] text-inherit focus-visible:outline-2 focus-visible:outline-dashboard-focus";

/**
 * Show one person the same way everywhere: the small photo and the name,
 * with their card on hover, focus, or tap. The name links to their People
 * page when they have one. Set `avatar={false}` where a large photo already
 * sits beside the name, and `card={false}` inside a control, such as a row
 * link, that cannot hold another one.
 */
export function PersonReference(props: {
  actions?: ReactNode;
  avatar?: boolean | undefined;
  card?: boolean | undefined;
  /** Classes of the name, such as a link or heading style. */
  className?: string | undefined;
  highlightSelf?: boolean | undefined;
  /** Text of the name, such as `@Name`. Defaults to the name. */
  label?: ReactNode;
  person: Person;
}) {
  const label = props.label ?? props.person.name;
  const className = props.className ?? NAME_CLASS;
  if (props.card === false) {
    return (
      <PersonInline
        avatar={props.avatar}
        highlightSelf={props.highlightSelf}
        person={props.person}
      >
        <span className={className}>{label}</span>
      </PersonInline>
    );
  }
  const { email } = props.person;
  return (
    <PersonInline
      avatar={props.avatar}
      highlightSelf={props.highlightSelf}
      person={props.person}
    >
      <HoverPreview
        content={<PersonCard actions={props.actions} person={props.person} />}
        tapToOpen
        trigger={
          email ? (
            <Link
              // Previews sit in cards that disable pointer events on their text.
              className={cn("pointer-events-auto", className)}
              to={peoplePath(email)}
            />
          ) : (
            <button className={cn(TRIGGER_CLASS, className)} type="button" />
          )
        }
      >
        {label}
      </HoverPreview>
    </PersonInline>
  );
}
