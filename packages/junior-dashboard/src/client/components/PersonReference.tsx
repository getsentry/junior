import { cloneElement, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { useDashboardCoreData } from "../api";
import { peoplePath } from "../format";
import type { Person } from "../person";
import { cn } from "../styles";
import { HoverPreview, useInsideHoverPreview } from "./ui/hover-preview";
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

function InlinePhoto(props: { person: Person }) {
  return (
    <PersonPhoto
      className="mr-1 inline-grid size-[1em] align-[-0.125em]"
      initialClassName="text-[0.6em]"
      person={props.person}
    />
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
      {props.avatar === false ? null : <InlinePhoto person={props.person} />}
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
 * page when they have one. The photo is part of the link. Set `photo` to a
 * larger photo in the link, `avatar={false}` where a large photo already
 * sits apart from the name, and `card={false}` inside a control, such as a
 * row link, that cannot hold another one.
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
  /** A larger photo that takes the place of the small one. */
  photo?: ReactNode;
}) {
  const inside = useInsideHoverPreview();
  const className = props.className ?? NAME_CLASS;
  const { email } = props.person;
  // The photo is part of the link, so it opens the card too.
  const name = (
    <>
      {props.photo ??
        (props.avatar === false ? null : <InlinePhoto person={props.person} />)}
      {props.label ?? props.person.name}
    </>
  );
  const link = email ? (
    <Link
      // Previews sit in cards that disable pointer events on their text.
      className={cn("pointer-events-auto", className)}
      to={peoplePath(email)}
    />
  ) : undefined;
  let reference: ReactNode;
  if (props.card === false || (inside && !link)) {
    reference = <span className={className}>{name}</span>;
  } else if (inside && link) {
    // A card inside another card would close with it, so only link.
    reference = cloneElement(link, undefined, name);
  } else {
    reference = (
      <HoverPreview
        content={<PersonCard actions={props.actions} person={props.person} />}
        tapToOpen
        trigger={
          link ?? (
            <button className={cn(TRIGGER_CLASS, className)} type="button" />
          )
        }
      >
        {name}
      </HoverPreview>
    );
  }
  return (
    <PersonInline
      avatar={false}
      highlightSelf={props.highlightSelf}
      person={props.person}
    >
      {reference}
    </PersonInline>
  );
}
