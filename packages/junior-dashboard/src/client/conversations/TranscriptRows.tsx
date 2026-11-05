import {
  createContext,
  useContext,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

import { cn } from "../styles";
import {
  ConversationCatchUpButton,
  ConversationCatchUpCard,
} from "./ConversationCatchUp";

/** Keep row padding and the gap between transcript entries in one place. */
export function TranscriptRows({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1", className)}
    />
  );
}

/**
 * Mark where unread rows start. The pinning hook can open the transcript here.
 */
export function TranscriptUnreadMarker() {
  return (
    <div className="grid gap-2 py-1" data-transcript-unread-marker="">
      {/* Equal side columns keep "New" centered when the catch-up offer shows. */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <span
          aria-label="New messages"
          className="h-px bg-dashboard-accent/50"
          role="separator"
        />
        <span
          aria-hidden="true"
          className="font-sans text-xs font-semibold text-dashboard-accent-text"
        >
          New
        </span>
        <div className="flex min-w-0 items-center gap-3">
          <span className="h-px flex-1 bg-dashboard-accent/50" />
          <ConversationCatchUpButton />
        </div>
      </div>
      <ConversationCatchUpCard />
    </div>
  );
}

/**
 * Open rows by key, for the rows of one transcript list. Rows far from the
 * viewport unmount, so a row that opens again reads its state here.
 */
export const TranscriptOpenRows = createContext<Map<string, boolean> | null>(
  null,
);

/**
 * Hold whether a transcript row part is open. With a key, the state stays
 * while the row unmounts outside the viewport.
 */
export function useTranscriptRowOpen(
  key: string | undefined,
): [boolean, (open: boolean) => void] {
  const openRows = useContext(TranscriptOpenRows);
  const [open, setOpenState] = useState(
    () => (key !== undefined && openRows?.get(key)) || false,
  );
  const setOpen = (value: boolean) => {
    setOpenState(value);
    if (key !== undefined) openRows?.set(key, value);
  };
  return [open, setOpen];
}

/**
 * Lay out one transcript row at its real size.
 *
 * Rows do not use `content-visibility: auto`. The list mounts only the rows
 * near the viewport, and a row that mounts above the reader can measure a
 * different size than its estimate. The scroll owner corrects the scroll
 * position for that, so keep estimates close and overscan large.
 */
export function TranscriptRow(props: {
  /** Stable row id that holds the reader's place while layout changes. */
  anchorKey?: string;
  children: ReactNode;
  indent?: boolean;
  /** Last event sequence in the row. Read positions use it. */
  seq?: number;
}) {
  return (
    <div
      className="py-1.5"
      data-scroll-anchor={props.anchorKey}
      data-transcript-seq={props.seq}
    >
      {props.indent ? (
        <div className="pl-11">{props.children}</div>
      ) : (
        props.children
      )}
    </div>
  );
}
