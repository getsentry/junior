import { ExternalLink } from "lucide-react";
import type { CodeChangeSize } from "@sentry/junior-plugin-api";

import { ChangeSize } from "../components/ChangeSize";
import { objectToneClass } from "../components/ObjectIcon";
import { displayPlainText } from "../display-text/plainText";
import { buttonVariants } from "../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { cn } from "../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { AskKindIcon } from "./askKind";
import type { CodeChangeHead } from "./codeChangeHead";
import { ROW_ACTION_BUTTON_CLASS } from "./RowHoverActions";

// A pill that sits in a line of text and wraps with it, so a wrapped title
// starts its next line at the left edge.
const INLINE_PILL_CLASS =
  "inline-flex h-5 items-center gap-1 rounded-md border px-1.5 align-[0.125em] font-sans text-xs font-medium leading-none whitespace-nowrap";

/**
 * The first line of a code change row, as one run of text: the state pill,
 * the title, then the breaking mark, the type, and the scope. A closed row
 * keeps it to two lines; an open one shows it in full.
 */
export function CodeChangeTitle(props: {
  expanded: boolean;
  head: CodeChangeHead;
}) {
  const { title } = props.head;
  return (
    <span
      className={cn(
        "min-w-0 break-words font-display text-base font-medium leading-snug text-dashboard-text",
        !props.expanded && "line-clamp-2",
      )}
      data-code-change-title=""
    >
      <span
        className={cn(
          INLINE_PILL_CLASS,
          "mr-1.5 border-dashboard-accent/40 bg-dashboard-accent/10 text-dashboard-accent",
        )}
        data-code-change-state=""
        title={props.head.kind}
      >
        <AskKindIcon className="size-3 text-current" kind={props.head.kind} />
        {props.head.state}
      </span>
      {displayPlainText(title.text)}
      {title.breaking ? (
        <span
          className={cn(
            INLINE_PILL_CLASS,
            "ml-1.5 border-rose-500/50 bg-rose-500/10",
            objectToneClass.danger,
          )}
          data-code-change-breaking=""
          title="Breaking change"
        >
          <span aria-hidden="true">!</span>
          <span className="sr-only">Breaking change</span>
        </span>
      ) : null}
      {title.type ? (
        <span
          className={cn(
            INLINE_PILL_CLASS,
            "ml-1.5 border-dashboard-border bg-dashboard-fill-soft text-dashboard-text-muted",
          )}
          data-code-change-type=""
        >
          {title.type}
        </span>
      ) : null}
      {title.scope ? (
        <span
          className="ml-1.5 font-sans text-xs font-normal whitespace-nowrap text-dashboard-text-faint"
          data-code-change-scope=""
        >
          {title.scope}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The second line of a code change row: the change's reference and size,
 * then where it was asked.
 */
export function CodeChangeSubtitle(props: {
  expanded: boolean;
  head: CodeChangeHead;
  size: CodeChangeSize | undefined;
  subtitle: string | undefined;
}) {
  return (
    <span className="flex min-w-0 items-baseline gap-x-1.5 text-xs text-dashboard-text-muted">
      <span className="shrink-0 tabular-nums">{props.head.reference}</span>
      <ChangeSize size={props.size} />
      {props.subtitle ? (
        <>
          <span aria-hidden="true" className="text-dashboard-text-faint">
            ·
          </span>
          <span
            className={
              props.expanded ? "min-w-0 break-words" : fadeOverflowClass
            }
            ref={fadeWhenOverflowing}
          >
            {props.subtitle}
          </span>
        </>
      ) : null}
    </span>
  );
}

/** The open row's first action: the change's page, such as on GitHub. */
export function CodeChangeOpenButton(props: { head: CodeChangeHead }) {
  return (
    <a
      className={cn(
        buttonVariants({ variant: "default" }),
        "pointer-coarse:h-11",
      )}
      data-code-change-open=""
      href={props.head.url}
      rel="noreferrer"
      target="_blank"
    >
      {props.head.openLabel}
      <ExternalLink aria-hidden="true" size={14} />
    </a>
  );
}

/** The closed row's hover action that opens the change's page. */
export function CodeChangeOpenLink(props: { head: CodeChangeHead }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            aria-label={props.head.openLabel}
            className={ROW_ACTION_BUTTON_CLASS}
            href={props.head.url}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink aria-hidden="true" size={14} />
          </a>
        }
      />
      <TooltipContent size="compact">{props.head.openLabel}</TooltipContent>
    </Tooltip>
  );
}
