import { useState } from "react";
import type {
  ReviewItemActionBody,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { useDashboardCoreData } from "../api";
import { InlineError } from "../components/InlineError";
import { UserInputForm } from "../components/UserInputForm";
import { Button } from "../components/ui/button";
import { DisplayText } from "../display-text/DisplayText";
import { DashboardApiError } from "../http";
import { useInboxUi } from "../uiShell";
import { useReviewItemAction, useSavedReviewItem } from "./queries";
import { answerRows, viewerAnswerLine } from "./reviewItemFormat";
import { useReportUnsentAnswer } from "./UnsentAnswers";
import { formatRelativeTime } from "../time";

function personLabel(person: {
  displayName?: string | undefined;
  email: string;
}) {
  return person.displayName ?? person.email;
}

function actionError(error: unknown): string {
  if (error instanceof DashboardApiError && error.apiError) {
    return error.apiError;
  }
  return "Could not save this action. Try again.";
}

/** Show the submitted answer as one line for each answered field. */
export function AnswerSummary(props: {
  answer: NonNullable<ReviewItemPayload["answer"]>;
  request: NonNullable<ReviewItemPayload["request"]>;
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
function ClosedSummary(props: { item: ReviewItemPayload }) {
  const { item } = props;
  const who = item.closedBy ? personLabel(item.closedBy) : "An agent";
  const what = item.status === "dismissed" ? "dismissed" : "closed";
  return (
    <div className="grid gap-2 text-sm">
      <p className="m-0 text-dashboard-text-muted">
        {who} {what} this {formatRelativeTime(item.closedAt)}.
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
 * Show the actions that the viewer can take on one Review item, or how it
 * closed. The review desk and the side panel use it. A caller that shows
 * its own Dismiss turns this one off.
 */
export function ReviewItemActions(props: {
  dismiss?: boolean;
  item: ReviewItemPayload;
  /** The take button's label, or false to leave it out. */
  take?: string | false;
}) {
  const { item } = props;
  const inbox = useInboxUi();
  const action = useReviewItemAction();
  const [error, setError] = useState<string>();
  const [unsent, setUnsent] = useState(false);
  useReportUnsentAnswer(item, unsent);
  // An Inbox row shows its items as the list read them until it leaves, so
  // the viewer's saved answer shows here, where it was given.
  const viewerEmail = useDashboardCoreData().data?.me.user.email;
  const saved = useSavedReviewItem(item.id);
  const answered =
    inbox &&
    saved &&
    saved.status !== "open" &&
    saved.closedBy?.email === viewerEmail
      ? viewerAnswerLine(saved)
      : undefined;

  if (item.status !== "open") return <ClosedSummary item={item} />;
  if (answered) {
    return (
      <p className="m-0 text-sm text-dashboard-text-muted" role="status">
        {answered}
      </p>
    );
  }
  if (!item.canAct) {
    return (
      <p className="m-0 text-sm text-dashboard-text-muted">
        Only an assignee can act on this item.
      </p>
    );
  }

  async function run(body: ReviewItemActionBody) {
    setError(undefined);
    try {
      await action.mutateAsync({ body, id: item.id });
    } catch (failure) {
      setError(actionError(failure));
      throw failure;
    }
  }

  const dismiss = props.dismiss ?? true;
  const take = item.canTake ? (props.take ?? "Take") : false;
  // Take and Dismiss are quiet, so the answer stays the main action.
  const secondaryActions = (
    <>
      {take ? (
        <Button
          disabled={action.isPending}
          onClick={() => void run({ action: "take" }).catch(() => {})}
          variant="ghost"
        >
          {take}
        </Button>
      ) : null}
      {dismiss ? (
        <Button
          disabled={action.isPending}
          onClick={() => void run({ action: "dismiss" }).catch(() => {})}
          variant="ghost"
        >
          Dismiss
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="grid gap-3">
      {item.kind === "action" && item.request ? (
        <div className="text-sm">
          <div className="font-medium">
            <DisplayText text={item.request.question} />
          </div>
          <UserInputForm
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
          />
        </div>
      ) : take || dismiss ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1 sm:ml-auto">
            {secondaryActions}
          </div>
        </div>
      ) : null}
      {error ? <InlineError>{error}</InlineError> : null}
    </div>
  );
}
