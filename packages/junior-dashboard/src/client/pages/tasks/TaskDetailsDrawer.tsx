import { useEffect, type ReactNode } from "react";
import type { TaskSummary } from "@sentry/junior/api/schema";
import { Link } from "react-router";
import { MapPin, X } from "lucide-react";
import { Button } from "../../components/Button";
import { conversationPath, formatTime, peoplePath } from "../../format";
import { TranscriptText } from "../../conversations/TranscriptText";

/** Show one task's instruction and metadata in a right-side slide-out. */
export function TaskDetailsDrawer(props: {
  onClose(): void;
  task: TaskSummary | undefined;
}) {
  useEffect(() => {
    if (!props.task) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose, props.task]);

  if (!props.task) return null;

  const { task } = props;
  const createdBy = task.createdByEmail ? (
    <Link
      className="font-semibold text-dashboard-text underline decoration-white/20 underline-offset-2 transition-colors hover:decoration-white/60"
      to={peoplePath(task.createdByEmail)}
    >
      {task.ownedByViewer ? "you" : task.createdBy}
    </Link>
  ) : task.ownedByViewer ? (
    "you"
  ) : (
    task.createdBy
  );
  const details =
    task.kind === "scheduled"
      ? [
          { label: "Schedule", value: task.schedule },
          {
            label: "Next run",
            value: task.nextRunAt ? formatRunDate(task.nextRunAt) : "None",
          },
        ]
      : [
          { label: "Resource", value: task.resource },
          { label: "Events", value: task.events.join(", ") },
        ];
  const statusLabel =
    task.kind === "scheduled"
      ? task.status
      : task.triggerAvailable
        ? "ready"
        : "unavailable";

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <button
        aria-label="Close task details"
        className="absolute inset-0 cursor-default bg-black/55"
        onClick={props.onClose}
        type="button"
      />
      <aside className="absolute top-0 right-0 grid h-full w-full grid-rows-[auto_minmax(0,1fr)] bg-[#070707] shadow-[-20px_0_60px_rgba(0,0,0,0.45)] md:w-[min(560px,94vw)] md:border-l md:border-white/12">
        <header className="relative border-b border-white/10 bg-dashboard-surface-raised px-4 py-3 md:px-5">
          <div className="min-w-0 pr-12">
            <div className="font-mono text-[0.58rem] uppercase tracking-[0.14em] text-cyan-200/65">
              Task details
            </div>
            <h2 className="mt-1 mb-0 font-display text-lg font-medium tracking-normal text-dashboard-text capitalize">
              {task.kind} task
            </h2>
            <div className="mt-1 break-words font-mono text-[0.78rem] leading-snug text-dashboard-text-muted">
              {statusLabel} · {formatDate(task.createdAt)}
            </div>
          </div>
          <div className="absolute top-3 right-4 md:right-5">
            <Button
              aria-label="Close task details"
              onClick={props.onClose}
              size="icon"
              title="Close"
            >
              <X aria-hidden="true" size={15} strokeWidth={2.25} />
            </Button>
          </div>
        </header>
        <div className="min-h-0 overflow-auto px-4 py-4 md:px-5">
          <section className="grid gap-5">
            <div>
              <div className="mb-2 font-mono text-[0.54rem] uppercase tracking-[0.12em] text-dashboard-text-muted">
                Instruction
              </div>
              <TranscriptText text={task.instruction} />
            </div>
            <dl className="grid gap-px overflow-hidden rounded border border-white/[0.06] bg-white/[0.055]">
              {details.map((detail) => (
                <TaskDetail key={detail.label} label={detail.label}>
                  {detail.value}
                </TaskDetail>
              ))}
              <TaskDetail label="Destination">
                <span className="inline-flex items-center gap-1.5">
                  <MapPin
                    aria-hidden="true"
                    className="text-cyan-300/70"
                    size={13}
                  />
                  {task.destination.label} · {task.destination.visibility}
                </span>
              </TaskDetail>
              <TaskDetail label="Created">
                {createdBy} · {formatDate(task.createdAt)}
              </TaskDetail>
              <TaskDetail label="Executions">
                <TaskExecutionSummary task={task} />
              </TaskDetail>
            </dl>
          </section>
        </div>
      </aside>
    </div>
  );
}

function TaskDetail(props: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0 bg-[#09090b] px-3 py-3">
      <dt className="font-mono text-[0.54rem] uppercase tracking-[0.12em] text-dashboard-text-muted">
        {props.label}
      </dt>
      <dd className="mt-1.5 ml-0 break-words text-sm leading-relaxed text-dashboard-text">
        {props.children}
      </dd>
    </div>
  );
}

function TaskExecutionSummary(props: {
  task: Pick<
    TaskSummary,
    "lastConversationId" | "lastRunAt" | "runsLast7Days" | "totalRuns"
  >;
}) {
  const { task } = props;
  return (
    <div className="text-sm text-dashboard-text-muted">
      <span className="text-dashboard-text">
        {task.runsLast7Days} runs / 7d
      </span>
      <span className="mx-2 opacity-45">·</span>
      <span>
        {task.totalRuns} total
        {task.lastRunAt ? " · Last execution " : " · Never run"}
        {task.lastRunAt && task.lastConversationId ? (
          <Link
            className="text-dashboard-text underline decoration-white/20 underline-offset-2 hover:decoration-white/60"
            to={conversationPath(task.lastConversationId)}
          >
            {formatRunDate(task.lastRunAt)}
          </Link>
        ) : task.lastRunAt ? (
          formatRunDate(task.lastRunAt)
        ) : null}
      </span>
    </div>
  );
}

function formatDate(value: string): string {
  return formatTime(value, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatRunDate(value: string): string {
  return formatTime(value, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZoneName: "short",
    year: "numeric",
  });
}
