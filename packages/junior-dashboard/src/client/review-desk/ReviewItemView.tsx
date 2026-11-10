import { ArrowRight, ChevronLeft, PanelRight } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { StatusChip } from "../components/StatusChip";
import { Button } from "../components/ui/button";
import { ChatLayout } from "../conversations/ChatLayout";
import { HeaderIconButton } from "../conversations/ConversationHeaderActions";
import { conversationPath } from "../conversations/conversationRoutes";
import { DisplayText } from "../display-text/DisplayText";
import { formatRelativeTime } from "../format";
import { ReviewItemActions } from "./ReviewItemActions";
import { ReviewItemContext } from "./ReviewItemContext";
import { reviewItemStatusLabel } from "./reviewItemFormat";

/** Space above the card when the view starts at its top. */
const CARD_TOP_MARGIN_PX = 24;

const textLinkClass =
  "inline-flex items-center gap-1.5 font-sans text-sm font-medium text-dashboard-text no-underline hover:underline focus-visible:outline-dashboard-focus";

/**
 * Show one Review item where a person decides it: the end of the
 * Conversation that added it, then its question and actions.
 */
export function ReviewItemView(props: {
  backTo: string;
  detailsOpen: boolean;
  item: ReviewItemPayload;
  next?: { title: string; to: string };
  onDetailsClick(): void;
  /** The title of the Conversation that added the item, when it is known. */
  sourceTitle?: string;
}) {
  const { item } = props;
  const open = item.status === "open";
  const articleRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  // Open at the decision: the messages above it are context. Show the end
  // of the page, or the top of the card when the card is taller than the
  // view. Messages load and grow after the first paint, so keep the place
  // until the reader scrolls or uses the page.
  useEffect(() => {
    const article = articleRef.current;
    const card = cardRef.current;
    const scroll = article?.closest<HTMLElement>("[data-chat-scroll]");
    if (!article || !card || !scroll) return;
    const observer = new ResizeObserver(() => {
      const cardTop =
        card.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top +
        scroll.scrollTop;
      scroll.scrollTop = Math.min(
        scroll.scrollHeight - scroll.clientHeight,
        cardTop - CARD_TOP_MARGIN_PX,
      );
    });
    const stop = () => observer.disconnect();
    const events = ["keydown", "pointerdown", "touchstart", "wheel"] as const;
    observer.observe(article);
    for (const name of events) {
      scroll.addEventListener(name, stop, { passive: true });
    }
    return () => {
      stop();
      for (const name of events) scroll.removeEventListener(name, stop);
    };
  }, []);
  const source = item.automationId ? "Automation" : props.sourceTitle;
  // A notice has no question, so its text is what the card shows.
  const bodyInCard = item.kind === "notice" || !item.request;
  const meta = (
    <>
      {source ? `${source} · ` : null}
      {formatRelativeTime(item.createdAt)}
      {item.visibility === "private" ? " · Private" : null}
    </>
  );
  const conversationLink = (
    <Link
      className={textLinkClass}
      to={conversationPath(item.addedByConversationId, {
        turnId: item.addedByTurnId,
      })}
    >
      Open conversation
      <ArrowRight aria-hidden="true" size={14} />
    </Link>
  );
  return (
    <ChatLayout
      header={
        <header className="border-b border-dashboard-border bg-dashboard-bg">
          {/* Desktop: one 48px row, like the conversation header. The title
              starts 24px in and the details button ends 24px from the edge. */}
          <div className="hidden h-12 min-w-0 items-center justify-between gap-2 pl-6 pr-4 md:flex">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="m-0 min-w-0 truncate font-display text-base font-medium leading-6 tracking-tight">
                {item.title}
              </h2>
              <StatusChip size="compact" tone={open ? "accent" : "neutral"}>
                {reviewItemStatusLabel(item)}
              </StatusChip>
              <span className="min-w-0 truncate text-xs text-dashboard-text-muted">
                {meta}
              </span>
            </div>
            {props.detailsOpen ? null : (
              <HeaderIconButton
                expanded={false}
                label="Review item details"
                onClick={props.onDetailsClick}
              >
                <PanelRight aria-hidden="true" size={16} strokeWidth={1.9} />
              </HeaderIconButton>
            )}
          </div>
          <div className="flex min-w-0 items-start justify-between gap-4 px-4 py-3 md:hidden">
            <div className="grid min-w-0 gap-1.5">
              <Link
                className="inline-flex items-center gap-1 font-sans text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text"
                to={props.backTo}
              >
                <ChevronLeft aria-hidden="true" size={14} />
                Inbox
              </Link>
              <h2 className="m-0 min-w-0 break-words font-display text-xl font-medium leading-tight tracking-tight">
                {item.title}
              </h2>
              <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-dashboard-text-muted">
                <StatusChip size="compact" tone={open ? "accent" : "neutral"}>
                  {reviewItemStatusLabel(item)}
                </StatusChip>
                <span>{meta}</span>
              </p>
            </div>
            <Button
              aria-label="Review item details"
              aria-pressed={props.detailsOpen}
              className="shrink-0"
              onClick={props.onDetailsClick}
            >
              <PanelRight aria-hidden="true" size={15} strokeWidth={2} />
              Details
            </Button>
          </div>
        </header>
      }
      scrollAriaLabel="Review item"
      scrollClassName="px-4 pb-6 md:px-7"
      scroll={
        <article
          aria-label={item.title}
          ref={articleRef}
          className="mx-auto grid w-full min-w-0 max-w-[52.5rem] gap-5 pt-5 md:pt-7"
        >
          <ReviewItemContext
            fallback={
              <div className="grid gap-3 font-sans text-sm leading-relaxed">
                {bodyInCard ? null : <DisplayText text={item.body} />}
                <div>{conversationLink}</div>
              </div>
            }
            item={item}
          />
          <section
            aria-label={open ? "Answer" : "Outcome"}
            ref={cardRef}
            className="grid min-w-0 gap-4 rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-panel p-4 font-sans text-sm md:p-5"
          >
            {bodyInCard ? <DisplayText text={item.body} /> : null}
            <ReviewItemActions item={item} />
          </section>
          {props.next ? (
            <div className="flex justify-end">
              <Link className={textLinkClass} replace to={props.next.to}>
                Next: {props.next.title}
                <ArrowRight aria-hidden="true" size={14} />
              </Link>
            </div>
          ) : null}
        </article>
      }
    />
  );
}
