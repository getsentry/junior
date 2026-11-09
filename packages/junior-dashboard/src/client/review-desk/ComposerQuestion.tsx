import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type {
  ReviewItemActionBody,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { InlineError } from "../components/InlineError";
import { UserInputForm } from "../components/UserInputForm";
import { Button } from "../components/ui/button";
import { DisplayText } from "../display-text/DisplayText";
import { DashboardApiError } from "../http";
import { useReviewItemAction, useReviewItemsData } from "./queries";
import { reviewItemWaitsForAnswer } from "./reviewItemFormat";
import { useReportUnsentAnswer } from "./UnsentAnswers";

/**
 * Return the open questions in a Conversation that the viewer can answer,
 * oldest first, so the question that waited longest docks first.
 */
export function useComposerQuestions(conversationId: string) {
  const { items, query } = useReviewItemsData({ conversationId });
  // The list keeps the items of the last Conversation while the new one
  // loads. Those questions are not for this Conversation.
  const stale = query.isPlaceholderData;
  const questions = useMemo(
    () => (stale ? [] : items.filter(reviewItemWaitsForAnswer)),
    [items, stale],
  );
  return { pending: query.isPending || stale, questions };
}

function actionError(error: unknown): string {
  if (error instanceof DashboardApiError && error.apiError) {
    return error.apiError;
  }
  return "Could not save this action. Try again.";
}

function isTextTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement)
  );
}

/**
 * Dock the open questions of a Conversation above its message box, one at a
 * time. The reader answers with a choice, a number key, or the form, or types
 * the answer in the message box. Esc dismisses the question. While the
 * question has focus, any other typed key moves focus to the message box, so
 * the key starts the answer there.
 */
export function ComposerQuestion(props: {
  /** Move focus to the message box. */
  focusMessageBox(): void;
  questions: readonly ReviewItemPayload[];
  ref?: Ref<HTMLElement>;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const sectionRef = useRef<HTMLElement | null>(null);
  // A closed question leaves the list, so the oldest open one shows next.
  const index = Math.max(
    0,
    props.questions.findIndex((item) => item.id === selectedId),
  );
  const item = props.questions[index];
  if (!item) return null;
  const count = props.questions.length;
  const step = (offset: number) =>
    setSelectedId(props.questions[(index + offset + count) % count]!.id);
  // Keep the keys working after an answer: the next question takes focus, or
  // the message box when none is left.
  const afterAction = () => {
    if (count > 1) sectionRef.current?.focus();
    else props.focusMessageBox();
  };

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isTextTarget(event.target)
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      sectionRef.current
        ?.querySelector<HTMLButtonElement>("[data-dismiss-question]")
        ?.click();
      return;
    }
    const choice = sectionRef.current?.querySelector<HTMLButtonElement>(
      `button[aria-keyshortcuts="${CSS.escape(event.key)}"]:not(:disabled)`,
    );
    if (choice) {
      event.preventDefault();
      choice.click();
      return;
    }
    // A printable key starts a typed answer. The browser sends the key to the
    // element that has focus after keydown, so the message box gets it.
    if (event.key.length === 1 && event.key !== " ") props.focusMessageBox();
  }

  return (
    <section
      aria-label={`Question: ${item.title}`}
      className="mb-2 grid min-w-0 gap-2 rounded-xl border border-dashboard-accent/30 bg-dashboard-surface-panel px-3 py-2.5 font-sans text-sm text-dashboard-text outline-none focus-visible:ring-2 focus-visible:ring-dashboard-focus/50 md:max-h-[50vh] md:overflow-y-auto md:px-4 md:py-3"
      onKeyDown={onKeyDown}
      ref={(node) => {
        sectionRef.current = node;
        if (typeof props.ref === "function") props.ref(node);
        else if (props.ref) props.ref.current = node;
      }}
      tabIndex={-1}
    >
      <DockedQuestion
        afterAction={afterAction}
        // A new question gets a fresh form, so picks do not carry over.
        key={item.id}
        item={item}
        stepper={
          count > 1 ? (
            <div className="flex shrink-0 items-center gap-0.5 text-xs text-dashboard-text-muted">
              <Button
                aria-label="Previous question"
                className="size-7"
                onClick={() => step(-1)}
                size="icon"
                variant="quiet"
              >
                <ChevronLeft aria-hidden="true" size={15} />
              </Button>
              <span className="tabular-nums">
                {index + 1} of {count}
              </span>
              <Button
                aria-label="Next question"
                className="size-7"
                onClick={() => step(1)}
                size="icon"
                variant="quiet"
              >
                <ChevronRight aria-hidden="true" size={15} />
              </Button>
            </div>
          ) : null
        }
      />
    </section>
  );
}

function DockedQuestion(props: {
  afterAction(): void;
  item: ReviewItemPayload;
  stepper: ReactNode;
}) {
  const { item } = props;
  const action = useReviewItemAction();
  const [error, setError] = useState<string>();
  const [unsent, setUnsent] = useState(false);
  useReportUnsentAnswer(item, unsent);

  async function run(body: ReviewItemActionBody) {
    setError(undefined);
    try {
      await action.mutateAsync({ body, id: item.id });
    } catch (failure) {
      setError(actionError(failure));
      throw failure;
    }
    props.afterAction();
  }

  return (
    <>
      <header className="flex min-w-0 items-center gap-2">
        <Inbox
          aria-hidden="true"
          className="shrink-0 text-dashboard-accent"
          size={15}
        />
        <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">
          {item.title}
        </h2>
        {props.stepper}
        <Button
          className="h-7 gap-1.5 px-2 text-xs"
          data-dismiss-question=""
          disabled={action.isPending}
          onClick={() => void run({ action: "dismiss" }).catch(() => {})}
          variant="quiet"
        >
          Dismiss
          <kbd
            aria-hidden="true"
            className="font-sans text-2xs text-dashboard-text-faint max-md:hidden"
          >
            Esc
          </kbd>
        </Button>
      </header>
      {item.request ? (
        <div className="min-w-0">
          <div className="font-medium [&_p]:my-0">
            <DisplayText text={item.request.question} />
          </div>
          <UserInputForm
            docked
            onSubmit={(answer) =>
              run({
                action: "submit",
                answer: {
                  values: answer.values,
                  ...(answer.other ? { other: answer.other } : undefined),
                },
              })
            }
            onUnsentChange={setUnsent}
            request={item.request}
            requestId={item.id}
            secondaryActions={
              item.canTake ? (
                <Button
                  disabled={action.isPending}
                  onClick={() => void run({ action: "take" }).catch(() => {})}
                  variant="quiet"
                >
                  Take
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : null}
      {error ? <InlineError>{error}</InlineError> : null}
    </>
  );
}
