import { useEffect, useState, type ReactNode } from "react";
import type {
  InboxItemActionBody,
  InboxItemPayload,
} from "@sentry/junior/api/schema";

import { clearAnswerDraft } from "../components/answerDrafts";
import { InlineError } from "../components/InlineError";
import { UserInputForm } from "../components/UserInputForm";
import { Button } from "../components/ui/button";
import { DisplayText } from "../display-text/DisplayText";
import { DashboardApiError } from "../http";
import { useFailedInboxItemAnswer, useInboxItemAction } from "./queries";
import { InboxItemEvidence } from "./InboxItemEvidence";
import { answerRows } from "./inboxItemFormat";
import { RowDoneButton } from "./RowSnoozeDismiss";
import { useReportUnsentAnswer } from "./UnsentAnswers";
import { formatRelativeTime } from "../time";
import { InboxItemCloser } from "./InboxItemPeople";

function actionError(error: unknown): string {
  if (error instanceof DashboardApiError && error.apiError) {
    return error.apiError;
  }
  return "Could not save this action. Try again.";
}

/** Show the submitted answer as one line for each answered field. */
export function AnswerSummary(props: {
  answer: NonNullable<InboxItemPayload["answer"]>;
  request: NonNullable<InboxItemPayload["request"]>;
}) {
  const rows = answerRows(props.request, props.answer);
  return (
    <dl className="m-0 grid gap-2 rounded-md bg-dashboard-fill-soft p-3">
      {rows.map((row) => (
        <div className="grid gap-0.5" key={row.label}>
          <dt className="text-xs font-medium text-dashboard-text-muted">
            {row.label}
          </dt>
          <dd className="m-0 whitespace-pre-wrap break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Show who closed an item, when, and the submitted answer. */
function ClosedSummary(props: { item: InboxItemPayload }) {
  const { item } = props;
  const what = item.status === "dismissed" ? "dismissed" : "closed";
  return (
    <div className="grid gap-2 text-sm">
      <p className="m-0 text-dashboard-text-muted">
        <InboxItemCloser item={item} /> {what} this{" "}
        {formatRelativeTime(item.closedAt)}.
      </p>
      {item.closeReason ? (
        <p className="m-0 text-dashboard-text-muted">{item.closeReason}</p>
      ) : null}
      {item.request && item.answer ? (
        <AnswerSummary answer={item.answer} request={item.request} />
      ) : null}
    </div>
  );
}

/**
 * Show the actions that the viewer can take on one Inbox item, or how it
 * closed. The Inbox, the transcript, and the side panel use it, so a
 * question reads the same on each. A caller that shows
 * its own Dismiss turns this one off. A To-do for the viewer has Done in
 * place of Dismiss. `onAction` takes the actions in its
 * place and reports their failures itself. An answer that failed shows
 * again in the form.
 */
export function InboxItemActions(props: {
  /** What Junior said around the question, after the question. */
  context?: ReactNode;
  dismiss?: boolean;
  /** More actions after Take and Dismiss, such as an Inbox card's Snooze. */
  extra?: ReactNode;
  item: InboxItemPayload;
  onAction?(body: InboxItemActionBody): Promise<void>;
  /** The take button's label, or false to leave it out. */
  take?: string | false;
}) {
  const { item } = props;
  const action = useInboxItemAction();
  const draft = useFailedInboxItemAnswer(item.id);
  const [error, setError] = useState<string>();
  const [unsent, setUnsent] = useState(false);
  // `onAction` sends without `action`, so it keeps its own pending state.
  const [sending, setSending] = useState(false);
  useReportUnsentAnswer(item, unsent);
  // An item can close elsewhere, such as in Slack, with answers unsent here.
  useEffect(() => {
    if (item.status !== "open") clearAnswerDraft(item.id);
  }, [item.id, item.status]);

  if (item.status !== "open") return <ClosedSummary item={item} />;
  if (!item.canAct) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 text-sm text-dashboard-text-muted">
          Only an assignee can act on this item.
        </p>
        {props.extra ? (
          <div className="flex flex-wrap gap-1 sm:ml-auto">{props.extra}</div>
        ) : null}
      </div>
    );
  }

  async function run(body: InboxItemActionBody) {
    if (props.onAction) {
      setSending(true);
      try {
        return await props.onAction(body);
      } finally {
        setSending(false);
      }
    }
    setError(undefined);
    try {
      await action.mutateAsync({ body, id: item.id });
    } catch (failure) {
      setError(actionError(failure));
      throw failure;
    }
  }

  // A To-do for the viewer closes with Done, its main action, not Dismiss.
  const todo = item.todoId !== undefined;
  const dismiss = !todo && (props.dismiss ?? true);
  const take = item.canTake ? (props.take ?? "Take") : false;
  // Take and Dismiss are quiet, so the answer stays the main action.
  const secondaryActions = (
    <>
      {take ? (
        <Button
          disabled={action.isPending || sending}
          onClick={() => void run({ action: "take" }).catch(() => {})}
          variant="ghost"
        >
          {take}
        </Button>
      ) : null}
      {dismiss ? (
        <Button
          disabled={action.isPending || sending}
          onClick={() => void run({ action: "dismiss" }).catch(() => {})}
          variant="ghost"
        >
          Dismiss
        </Button>
      ) : null}
      {props.extra}
      {todo ? (
        <RowDoneButton
          disabled={action.isPending || sending}
          onClick={() => void run({ action: "done" }).catch(() => {})}
        />
      ) : null}
    </>
  );

  return (
    <div className="grid gap-3">
      {item.kind === "action" && item.request ? (
        <div className="grid gap-3 text-sm">
          {/* The question comes first and in full, then what Junior said
              around it. */}
          <section aria-label="Question" className="grid gap-1">
            <span className="text-xs text-dashboard-text-muted">Question</span>
            <div className="font-medium [&_p]:my-0">
              <DisplayText
                mentions={item.mentions}
                text={item.request.question}
              />
            </div>
          </section>
          {props.context}
          <InboxItemEvidence item={item} />
          <UserInputForm
            draft={draft}
            onUnsentChange={setUnsent}
            onSubmit={(answer) =>
              run({
                action: "submit",
                answer: {
                  values: answer.values,
                  ...(answer.other ? { other: answer.other } : undefined),
                },
              })
            }
            request={item.request}
            requestId={item.id}
            secondaryActions={secondaryActions}
            // Core takes an Automation alert's step and reads no words.
            words={item.owner.kind !== "automation"}
          />
        </div>
      ) : take || dismiss || todo || props.extra ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* The actions sit at the right edge, as on a desktop. */}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
            {secondaryActions}
          </div>
        </div>
      ) : null}
      {error ? <InlineError>{error}</InlineError> : null}
    </div>
  );
}
