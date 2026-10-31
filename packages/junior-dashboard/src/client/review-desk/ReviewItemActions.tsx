import { useState } from "react";
import {
  normalizeUserInputAnswer,
  type ReviewItemActionBody,
  type ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { InlineError } from "../components/InlineError";
import { UserInputForm } from "../components/UserInputForm";
import { Button } from "../components/ui/button";
import { TranscriptMarkdown } from "../conversations/TranscriptMarkdown";
import { formatRelativeTime } from "../format";
import { DashboardApiError } from "../http";
import { useReviewItemAction } from "./queries";

function personLabel(person: { displayName?: string; email: string }) {
  return person.displayName ?? person.email;
}

function actionError(error: unknown): string {
  if (error instanceof DashboardApiError && error.apiError) {
    return error.apiError;
  }
  return "Could not save this action. Try again.";
}

/** Show the submitted answer as one line for each answered field. */
function AnswerSummary(props: {
  answer: NonNullable<ReviewItemPayload["answer"]>;
  request: NonNullable<ReviewItemPayload["request"]>;
}) {
  const answer = normalizeUserInputAnswer(props.request, props.answer);
  const rows = props.request.fields.flatMap((field) => {
    const values = answer.values[field.id];
    return values?.length
      ? [{ label: field.label, value: values.join(", ") }]
      : [];
  });
  if (answer.other) rows.push({ label: "Other", value: answer.other });
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
 * closed. The review desk, the transcript card, and the side panel use it.
 */
export function ReviewItemActions(props: { item: ReviewItemPayload }) {
  const { item } = props;
  const action = useReviewItemAction();
  const [error, setError] = useState<string>();

  if (item.status !== "open") return <ClosedSummary item={item} />;
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

  return (
    <div className="grid gap-3">
      {item.kind === "action" && item.request ? (
        <div className="grid gap-2 text-sm">
          <TranscriptMarkdown text={item.request.question} />
          <UserInputForm
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
          />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {item.kind === "notice" ? (
          <Button
            disabled={action.isPending}
            onClick={() => void run({ action: "complete" }).catch(() => {})}
            variant="primary"
          >
            Done
          </Button>
        ) : null}
        <Button
          disabled={action.isPending}
          onClick={() => void run({ action: "dismiss" }).catch(() => {})}
        >
          Dismiss
        </Button>
        {item.canTake ? (
          <Button
            disabled={action.isPending}
            onClick={() => void run({ action: "take" }).catch(() => {})}
          >
            Take
          </Button>
        ) : null}
      </div>
      {error ? <InlineError>{error}</InlineError> : null}
    </div>
  );
}
