import { useQuery } from "@tanstack/react-query";
import {
  annotationCard,
  type ConversationDetailReport,
  type OwnedObjectAnnotation,
  type ReviewItemPayload,
} from "@sentry/junior/api/schema";
import {
  objectFactFields,
  objectPresentation,
} from "@sentry/junior-plugin-api";
import { useEffect } from "react";

import { ClampedPreview } from "../components/ClampedPreview";
import { ObjectIcon } from "../components/ObjectIcon";
import { OutboundLink } from "../components/OutboundLink";
import { StatusChip } from "../components/StatusChip";
import { conversationDetailQueryOptions } from "../conversations/queries";
import {
  DisplayText,
  MessageObjectsProvider,
  objectUrlKey,
  useResolvedObject,
} from "../display-text/DisplayText";
import { reviewItemSubjectHref } from "./reviewItemFormat";

type Subject = NonNullable<ReviewItemPayload["subject"]>;

/**
 * Show the outside object that an item is about, such as a pull request, as
 * one card on every Inbox surface: its title, reference, state and facts,
 * such as a branch, then the first lines of its description. The card is the
 * object annotation that a plugin saved on the item's Conversation for the
 * same URL, or the card that the API resolves for the URL when none is
 * saved. The item's text leaves out a bare URL to the subject, so the card
 * shows once (`withoutStandaloneUrl`).
 */
export function ReviewItemSubjectPreview(props: {
  subject: Subject;
  conversationId: string;
}) {
  return (
    <MessageObjectsProvider>
      <SubjectCard {...props} />
    </MessageObjectsProvider>
  );
}

function SubjectCard(props: { subject: Subject; conversationId: string }) {
  const { subject } = props;
  const href = subject.url ? reviewItemSubjectHref(subject.url) : undefined;
  const detail = useQuery(conversationDetailQueryOptions(props.conversationId));
  const saved = savedCard(detail.data?.annotations, subject, href);
  // Ask for a live card only once the saved ones are known.
  const liveUrl = saved || detail.isPending ? undefined : href;
  const live = useResolvedObject(liveUrl);
  const { request } = live;
  useEffect(() => {
    if (liveUrl) request();
  }, [liveUrl, request]);
  const card = saved ?? live.card;
  const title = card?.title ?? subject.title ?? href ?? subject.id;
  const type = card
    ? (card.displayType ?? objectPresentation(card).label)
    : undefined;
  const facts = card ? objectFactFields(card.facts) : [];
  return (
    <section
      aria-label={type ? `${type}: ${title}` : title}
      className="grid min-w-0 gap-2 rounded-lg border border-dashboard-border px-3 py-2.5 font-sans text-sm"
      data-subject-card=""
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {card ? <ObjectIcon {...card} className="mt-0.5" size={16} /> : null}
        <div className="grid min-w-0 flex-1 gap-0.5">
          {href ? (
            <OutboundLink
              className="min-w-0 break-words font-medium text-dashboard-text hover:underline focus-visible:outline-dashboard-focus"
              href={href}
            >
              {title}
            </OutboundLink>
          ) : (
            <strong className="min-w-0 break-words font-medium text-dashboard-text">
              {title}
            </strong>
          )}
          {card ? (
            <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dashboard-text-muted">
              {/* A label that repeats the title says nothing new. */}
              {card.label === card.title ? null : (
                <span className="min-w-0 break-words">{card.label}</span>
              )}
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
            </p>
          ) : null}
        </div>
      </div>
      {card?.description ? (
        <ClampedPreview
          className="leading-6"
          label={`description of ${title}`}
          lines={3}
        >
          {/* A description is a Markdown file, such as a pull request body. */}
          <DisplayText document text={card.description} />
        </ClampedPreview>
      ) : null}
    </section>
  );
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
