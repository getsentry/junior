import type { WakeAutomationPayload } from "@sentry/junior/api/schema";
import { Clock3 } from "lucide-react";
import { Link } from "react-router";

import { Button } from "../../../components/ui/button";
import { formatAutomationRunTime } from "../../../pages/automations/automationFormat";
import { snoozeWakesAtMs } from "../../../review-desk/inboxSnoozes";
import {
  INBOX_ROW_META_CLASS,
  inboxCardClass,
  inboxHeadGridClass,
} from "../../../review-desk/inboxRowStyles";
import { cn } from "../../../styles";
import { formatRelativeTime } from "../../../time";

/**
 * Show one of the viewer's snoozes as an Automation card: the row it hides,
 * what wakes it, and a Wake button that brings the row back now.
 */
export function SnoozeRow(props: {
  onWake(): void;
  snooze: WakeAutomationPayload;
  waking: boolean;
}) {
  const { snooze } = props;
  const title = snooze.title ?? "Snoozed row";
  const wakesAtMs = snoozeWakesAtMs(snooze);
  const wakesAt =
    wakesAtMs === undefined ? undefined : new Date(wakesAtMs).toISOString();
  return (
    <li className={inboxCardClass(false)} data-dock-key={`snooze:${snooze.id}`}>
      <div className={cn(inboxHeadGridClass(), "pb-3")}>
        <Clock3
          aria-hidden="true"
          className="col-start-1 row-start-1 mt-[0.2rem] size-3.5 justify-self-center text-dashboard-text-muted"
          strokeWidth={1.9}
        />
        <div className="col-start-2 row-start-1 grid min-w-0 gap-1">
          <Link
            className="min-w-0 truncate rounded-md text-sm leading-snug font-medium text-dashboard-text no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
            title={title}
            to="/?view=snoozed"
          >
            {title}
          </Link>
          <span className="min-w-0 truncate text-xs text-dashboard-text-muted">
            {wakesAt
              ? `Snoozed until ${formatAutomationRunTime(wakesAt)}, or a new item`
              : "Snoozed until a new item"}
          </span>
        </div>
        <div className={cn(INBOX_ROW_META_CLASS, "items-start gap-5")}>
          <span className="text-xs whitespace-nowrap text-dashboard-text">
            {wakesAt ? `Wakes ${formatRelativeTime(wakesAt)}` : "Waiting"}
          </span>
          <Button
            disabled={props.waking}
            onClick={props.onWake}
            variant="outline"
          >
            Wake
          </Button>
        </div>
      </div>
    </li>
  );
}
