import { useQuery } from "@tanstack/react-query";
import {
  annotationCard,
  type ConversationDetailReport,
  type OwnedObjectAnnotation,
  type InboxItemPayload,
} from "@sentry/junior/api/schema";
import {
  objectFactFields,
  objectPresentation,
} from "@sentry/junior-plugin-api";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { ChangeSize } from "../components/ChangeSize";
import { ObjectIcon } from "../components/ObjectIcon";
import { OutboundLink } from "../components/OutboundLink";
import { StatusChip } from "../components/StatusChip";
import { conversationDetailQueryOptions } from "../conversations/queries";
import {
  DisplayText,
  MessageObjectsProvider,
  objectUrlKey,
  sameTypeCard,
  useResolvedObject,
} from "../display-text/DisplayText";
import { cn } from "../styles";
import { AskKindIcon } from "./askKind";
import { inboxItemSubjectHref } from "./inboxItemFormat";

type Subject = NonNullable<InboxItemPayload["subject"]>;

/**
 * Show the outside object that an item is about, such as a pull request, as
 * one card on every Inbox surface: its title, reference, state and facts,
 * such as a branch, then the first lines of its description. The card is the
 * one that the API resolves for the URL, so it shows the object as it is
 * now. Until it resolves, the object annotation that a plugin saved on the
 * item's Conversation for the same URL shows. The item's text leaves out a
 * bare URL to the subject, so the card shows once (`withoutStandaloneUrl`).
 * Where the row already names the subject, `titled={false}` leaves its
 * title and size out, and the reference links to it.
 */
export function InboxItemSubjectPreview(props: {
  subject: Subject;
  conversationId: string | undefined;
  titled?: boolean;
}) {
  return (
    <MessageObjectsProvider>
      <SubjectCard {...props} />
    </MessageObjectsProvider>
  );
}

function SubjectCard(props: {
  subject: Subject;
  conversationId: string | undefined;
  titled?: boolean;
}) {
  const { subject } = props;
  const href = subject.url ? inboxItemSubjectHref(subject.url) : undefined;
  const detail = useQuery(conversationDetailQueryOptions(props.conversationId));
  const live = useResolvedObject(href);
  const { request } = live;
  useEffect(() => {
    if (href) request();
  }, [href, request]);
  const saved = savedCard(detail.data?.annotations, subject, href);
  const card =
    sameTypeCard(live.card, subject.objectType ?? saved?.objectType) ?? saved;
  const title = card?.title ?? subject.title ?? href ?? subject.id;
  const type = card
    ? (card.displayType ?? objectPresentation(card).label)
    : undefined;
  const facts = card ? objectFactFields(card.facts) : [];
  const titled = props.titled ?? true;
  // Untitled, the reference names the link. A label that repeats the title
  // says nothing new.
  const label =
    card?.label && (!titled || card.label !== card.title)
      ? card.label
      : undefined;
  const linkText = titled ? title : (label ?? title);
  return (
    <section
      aria-label={type ? `${type}: ${title}` : title}
      className={cn(
        "grid min-w-0 gap-2 font-sans text-sm",
        // Untitled, it is one line of facts in the row's detail, so it
        // needs no box of its own.
        titled && "rounded-lg border border-dashboard-border px-3 py-2.5",
      )}
      data-subject-card=""
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {card ? <ObjectIcon {...card} className="mt-0.5" size={16} /> : null}
        <div
          className={cn(
            "min-w-0 flex-1",
            titled
              ? "grid gap-0.5"
              : "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dashboard-text-muted",
          )}
        >
          {href ? (
            <OutboundLink
              className={cn(
                "min-w-0 break-words hover:underline focus-visible:outline-dashboard-focus",
                titled
                  ? "font-medium text-dashboard-text"
                  : "text-dashboard-text",
              )}
              href={href}
            >
              {linkText}
            </OutboundLink>
          ) : (
            <strong className="min-w-0 break-words font-medium text-dashboard-text">
              {linkText}
            </strong>
          )}
          {card ? (
            <p
              className={cn(
                "m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dashboard-text-muted",
                // Untitled, the facts share the reference's line.
                !titled && "contents",
              )}
            >
              {titled && label ? (
                <span className="min-w-0 break-words">{label}</span>
              ) : null}
              {card.status ? (
                <StatusChip size="compact" tone={objectPresentation(card).tone}>
                  {card.status}
                </StatusChip>
              ) : null}
              {facts.map((field) => (
                <span className="min-w-0 break-words" key={field.key}>
                  <span className="text-dashboard-text-faint">
                    {field.label}
                  </span>{" "}
                  {field.value}
                </span>
              ))}
              {/* Untitled, the row's head shows the size. */}
              {!titled || card.facts?.type !== "code_change" ? null : (
                <ChangeSize size={card.facts} />
              )}
            </p>
          ) : null}
        </div>
      </div>
      {card?.description ? (
        <SubjectDescription
          label={`description of ${title}`}
          text={card.description}
        />
      ) : null}
    </section>
  );
}

/**
 * The subject's description, quoted under a rule so it never reads as the
 * item's own text. Closed, it runs together as two small muted lines that
 * end on a word, as a row summary does. "Show more" opens the whole file.
 */
function SubjectDescription(props: { label: string; text: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () =>
      setMore(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);
  return (
    <div className="grid min-w-0 justify-items-start gap-1 border-l-2 border-dashboard-border pl-3">
      <div className="min-w-0 justify-self-stretch" id={id}>
        {open ? (
          // A description is a Markdown file, such as a pull request body.
          <DisplayText document text={props.text} />
        ) : (
          <div
            className="line-clamp-2 text-xs leading-5 text-dashboard-text-muted"
            ref={ref}
          >
            <DisplayText inline text={props.text} />
          </div>
        )}
      </div>
      {more || open ? (
        <button
          aria-controls={id}
          aria-expanded={open}
          aria-label={`${open ? "Show less" : "Show more"} of the ${props.label}`}
          className="cursor-pointer rounded-sm border-0 bg-transparent p-0 font-sans text-xs font-medium text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
          onClick={() => setOpen(!open)}
          type="button"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Say "Merge conflict" on an ask about a code change that conflicts with its
 * target branch. It reads the live card, because a saved card keeps the
 * merge state from when it was saved. It is only a line on the ask: it
 * notifies nobody and counts nowhere.
 */
export function SubjectMergeConflict(props: { subject: Subject }) {
  return (
    <MessageObjectsProvider>
      <MergeConflict {...props} />
    </MessageObjectsProvider>
  );
}

function MergeConflict(props: { subject: Subject }) {
  if (useCodeChangeFacts(props.subject)?.mergeable !== false) return null;
  return (
    <p
      className="m-0 flex items-center gap-1.5 text-sm text-dashboard-text-muted"
      data-merge-conflict=""
    >
      <AskKindIcon kind="FYI" />
      Merge conflict
    </p>
  );
}

/**
 * Return the live facts of the code change that an item is about, from the
 * nearest `MessageObjectsProvider`. Undefined until the card resolves, and
 * for a subject that is not a code change.
 */
export function useCodeChangeFacts(subject: Subject | undefined) {
  const href =
    subject?.objectType === "code_change" && subject.url
      ? inboxItemSubjectHref(subject.url)
      : undefined;
  const { card, request } = useResolvedObject(href);
  useEffect(() => {
    if (href) request();
  }, [href, request]);
  return card?.facts?.type === "code_change" ? card.facts : undefined;
}

// The object annotation for the subject's URL or key. A saved link with no
// facts is not a card.
function savedCard(
  annotations: ConversationDetailReport["annotations"],
  subject: Subject,
  href: string | undefined,
): OwnedObjectAnnotation | undefined {
  const key = href ? objectUrlKey(href) : undefined;
  const annotation = annotations?.find(
    (candidate) =>
      candidate.kind === "object" &&
      (candidate.key === subject.id ||
        (key !== undefined &&
          Boolean(candidate.url) &&
          objectUrlKey(candidate.url ?? "") === key)),
  );
  return annotation ? annotationCard(annotation) : undefined;
}
