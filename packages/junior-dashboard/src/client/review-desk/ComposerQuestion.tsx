import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
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
import {
  UserInputForm,
  type UserInputFormHandle,
} from "../components/UserInputForm";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { DisplayText } from "../display-text/DisplayText";
import { DashboardApiError } from "../http";
import { useReviewItemAction, useReviewItemsData } from "./queries";
import { reviewItemWaitsForAnswer } from "./reviewItemFormat";

/** Lets the message box send the picks of the docked questions. */
export type ComposerQuestionAnswers = {
  /** Send every question that has picks. Resolves false when one fails. */
  send(): Promise<boolean>;
};

/**
 * Return the open questions in a Conversation that the viewer can answer,
 * oldest first, so the question that waited longest docks first.
 */
export function useComposerQuestions(conversationId: string) {
  const { items, query } = useReviewItemsData({ conversationId });
  // The list keeps the items of the last Conversation while the new one
  // loads. Those questions are not for this Conversation.
  const stale = query.isPlaceholderData;
  // The list pages through every open item, notices too, so a question can
  // sit past the first page. Load every page so each question docks.
  const { fetchNextPage, hasNextPage, isFetching } = query;
  // A failed page stops the loop, so it does not retry without end.
  const failed = query.isFetchNextPageError;
  // Each page that lands asks for the next one. The fetch flags alone can
  // end where they started, so the loop would not run again.
  const pageCount = query.data?.pages.length ?? 0;
  useEffect(() => {
    if (stale || failed || !hasNextPage || isFetching) return;
    void fetchNextPage();
  }, [failed, fetchNextPage, hasNextPage, isFetching, pageCount, stale]);
  const questions = useMemo(
    () => (stale ? [] : items.filter(reviewItemWaitsForAnswer)),
    [items, stale],
  );
  // A failed page hides the questions on it and after it.
  const loadFailed = !stale && (failed || (query.isError && !query.data));
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  return {
    loadFailed,
    // The questions are known only when every page is in. Before that, a
    // question on a later page would dock after the focus went elsewhere,
    // and it would count as one that just arrived. A failed page stays
    // pending until Try again loads it.
    pending: query.isPending || stale || Boolean(hasNextPage) || loadFailed,
    questions,
    retry,
  };
}

/** Say that some open questions did not load, with a way to try again. */
export function ComposerQuestionsLoadError(props: { onRetry(): void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <InlineError className="w-auto">Some questions did not load.</InlineError>
      <Button
        className="h-7 px-2 text-xs"
        onClick={props.onRetry}
        variant="ghost"
      >
        Try again
      </Button>
    </div>
  );
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
 * time. A choice or its number key is the answer. Form picks go with the
 * next send from the message box, which also takes the answer in the
 * reader's own words. Esc dismisses the question. While the question has
 * focus, any other typed key moves focus to the message box, so the key
 * starts the answer there. `onShow` reports each question that docks, and
 * whether the reader moved to it, so the transcript can show where it
 * came from. A click on the title reports the question again.
 */
export function ComposerQuestion(props: {
  /** Lets the message box send the picks. */
  answersRef?: Ref<ComposerQuestionAnswers>;
  /** Move focus to the message box. */
  focusMessageBox(): void;
  /** Reports whether a question has picks that are not sent. */
  onAnswersChange(hasAnswers: boolean): void;
  /** Reports the question that shows, and whether the reader moved to it. */
  onShow?(item: ReviewItemPayload, byReader: boolean): void;
  questions: readonly ReviewItemPayload[];
  ref?: Ref<HTMLElement>;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const sectionRef = useRef<HTMLElement | null>(null);
  const formsRef = useRef(new Map<string, UserInputFormHandle>());
  const [withPicks, setWithPicks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const onPicksChange = useCallback((id: string, picked: boolean) => {
    setWithPicks((current) => {
      if (current.has(id) === picked) return current;
      const next = new Set(current);
      if (picked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  // A closed question leaves the list, so its picks no longer count.
  const hasAnswers = props.questions.some((question) =>
    withPicks.has(question.id),
  );
  const { onAnswersChange } = props;
  useEffect(() => {
    onAnswersChange(hasAnswers);
  }, [hasAnswers, onAnswersChange]);
  // A send from the message box keeps focus there.
  const sendingFromMessageBoxRef = useRef(false);
  // A step, or an answer to the shown question, moves the reader to the
  // next question. A question that docks by itself is not their move.
  const readerMovedRef = useRef(false);
  useImperativeHandle(props.answersRef, () => ({
    send: async () => {
      sendingFromMessageBoxRef.current = true;
      const sends = props.questions.flatMap((question) => {
        const send = formsRef.current.get(question.id)?.sendPicks();
        return send ? [send.then((sent) => ({ id: question.id, sent }))] : [];
      });
      try {
        const failed = (await Promise.all(sends)).find((send) => !send.sent);
        // A failed pick can sit on a hidden question. Show it, so its error
        // tells the reader why the message did not go.
        if (failed && failed.id !== item?.id) {
          readerMovedRef.current = true;
          setSelectedId(failed.id);
        }
        return !failed;
      } finally {
        sendingFromMessageBoxRef.current = false;
      }
    },
  }));
  // A closed question leaves the list, so the oldest open one shows next.
  const index = Math.max(
    0,
    props.questions.findIndex((item) => item.id === selectedId),
  );
  const item = props.questions[index];
  const shownIdRef = useRef<string>(undefined);
  const { onShow } = props;
  useEffect(() => {
    const previous = shownIdRef.current;
    shownIdRef.current = item?.id;
    if (!item) {
      readerMovedRef.current = false;
      return;
    }
    if (item.id === previous) return;
    const byReader = readerMovedRef.current;
    readerMovedRef.current = false;
    onShow?.(item, byReader);
  }, [item, onShow]);
  if (!item) return null;
  const count = props.questions.length;
  const step = (offset: number) => {
    readerMovedRef.current = true;
    setSelectedId(props.questions[(index + offset + count) % count]!.id);
  };
  // Keep the keys working after an action: the question keeps focus while one
  // is open, and the message box takes it when none is left. Take keeps the
  // question open.
  const afterAction = (closed: boolean) => {
    if (sendingFromMessageBoxRef.current) return;
    if (closed && count === 1) props.focusMessageBox();
    else sectionRef.current?.focus();
  };
  const current = () =>
    sectionRef.current?.querySelector("[data-current-question]");

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
      current()
        ?.querySelector<HTMLButtonElement>("[data-dismiss-question]")
        ?.click();
      return;
    }
    const choice = current()?.querySelector<HTMLButtonElement>(
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
      // Esc here dismisses the question, so it does not leave the page.
      data-escape-scope=""
      className="mb-2 grid min-w-0 gap-2 rounded-xl border border-dashboard-accent/30 bg-dashboard-surface-panel px-3 py-2.5 font-sans text-sm text-dashboard-text outline-none focus-visible:ring-2 focus-visible:ring-dashboard-focus/50 md:max-h-[50vh] md:overflow-y-auto md:px-4 md:py-3"
      onKeyDown={onKeyDown}
      ref={(node) => {
        sectionRef.current = node;
        if (typeof props.ref === "function") props.ref(node);
        else if (props.ref) props.ref.current = node;
      }}
      tabIndex={-1}
    >
      {/* Every open question stays mounted, so its picks survive a step to
          another question and go with the next send. */}
      {props.questions.map((question, position) => (
        <div
          className={position === index ? "grid min-w-0 gap-2" : "hidden"}
          data-current-question={position === index ? "" : undefined}
          key={question.id}
        >
          <DockedQuestion
            afterAction={afterAction}
            formRef={(handle) => {
              if (handle) formsRef.current.set(question.id, handle);
              else formsRef.current.delete(question.id);
            }}
            item={question}
            onCloseShown={(closing) => {
              if (position === index) readerMovedRef.current = closing;
            }}
            onPicksChange={onPicksChange}
            onShowRecord={() => onShow?.(question, true)}
            stepper={
              count > 1 ? (
                <div className="flex shrink-0 items-center gap-0.5 text-xs text-dashboard-text-muted">
                  <Button
                    aria-label="Previous question"
                    className="size-7"
                    onClick={() => step(-1)}
                    size="icon"
                    variant="ghost"
                  >
                    <ChevronLeft aria-hidden="true" size={15} />
                  </Button>
                  <span className="tabular-nums">
                    {position + 1} of {count}
                  </span>
                  <Button
                    aria-label="Next question"
                    className="size-7"
                    onClick={() => step(1)}
                    size="icon"
                    variant="ghost"
                  >
                    <ChevronRight aria-hidden="true" size={15} />
                  </Button>
                </div>
              ) : null
            }
          />
        </div>
      ))}
    </section>
  );
}

function DockedQuestion(props: {
  afterAction(closed: boolean): void;
  formRef: Ref<UserInputFormHandle>;
  item: ReviewItemPayload;
  /** An action starts to close this question, or failed to close it. */
  onCloseShown(closing: boolean): void;
  onShowRecord(): void;
  onPicksChange(id: string, picked: boolean): void;
  stepper: ReactNode;
}) {
  const { item, onPicksChange } = props;
  const action = useReviewItemAction();
  const [error, setError] = useState<string>();
  const [unsent, setUnsent] = useState(false);
  useEffect(() => {
    onPicksChange(item.id, unsent);
  }, [item.id, onPicksChange, unsent]);

  async function run(body: ReviewItemActionBody) {
    setError(undefined);
    const closing = body.action !== "take";
    // The list can drop the item before the action resolves.
    if (closing) props.onCloseShown(true);
    try {
      await action.mutateAsync({ body, id: item.id });
    } catch (failure) {
      if (closing) props.onCloseShown(false);
      setError(actionError(failure));
      throw failure;
    }
    props.afterAction(body.action !== "take");
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
          {/* The title shows where Junior asked in the transcript. */}
          <Button
            className="max-w-full truncate text-left focus-visible:rounded-sm focus-visible:outline-offset-0"
            onClick={props.onShowRecord}
            variant="link"
          >
            {item.title}
          </Button>
        </h2>
        {props.stepper}
        <Button
          className="h-7 gap-1.5 px-2 text-xs"
          data-dismiss-question=""
          disabled={action.isPending}
          onClick={() => void run({ action: "dismiss" }).catch(() => {})}
          variant="ghost"
        >
          Dismiss
          <Kbd
            aria-hidden="true"
            className="text-2xs text-dashboard-text-faint max-md:hidden"
            variant="plain"
          >
            Esc
          </Kbd>
        </Button>
      </header>
      {item.request ? (
        <div className="min-w-0">
          <div className="font-medium [&_p]:my-0">
            <DisplayText text={item.request.question} />
          </div>
          <UserInputForm
            docked
            ref={props.formRef}
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
                  variant="ghost"
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
