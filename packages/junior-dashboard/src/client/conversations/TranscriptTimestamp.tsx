import { createContext, useContext, useState, type ReactNode } from "react";

import { Tooltip } from "../components/Tooltip";
import {
  formatMessageTimestamp,
  formatRelativeMessageTimestamp,
  formatTranscriptTimestampDetails,
} from "../format";

const FULL_TIMESTAMP_AGE_MS = 12 * 60 * 60 * 1000;

const TranscriptTimestampContext = createContext<{
  full: boolean;
  toggle(): void;
} | null>(null);

/** Share the selected timestamp display mode across one transcript. */
export function TranscriptTimestampProvider(props: { children: ReactNode }) {
  const [full, setFull] = useState(false);
  return (
    <TranscriptTimestampContext.Provider
      value={{ full, toggle: () => setFull((value) => !value) }}
    >
      {props.children}
    </TranscriptTimestampContext.Provider>
  );
}

/** Render a transcript message timestamp and toggle absolute timestamps on press. */
export function TranscriptTimestamp(props: { value: number | undefined }) {
  const context = useContext(TranscriptTimestampContext);
  const valid = typeof props.value === "number" && Number.isFinite(props.value);
  const old = valid && Date.now() - props.value! > FULL_TIMESTAMP_AGE_MS;
  const label = context?.full
    ? formatMessageTimestamp(props.value, true)
    : old
      ? formatRelativeMessageTimestamp(props.value)
      : formatMessageTimestamp(props.value);

  const button = (
    <button
      className="cursor-pointer border-0 bg-transparent p-0 font-inherit text-inherit"
      onClick={context?.toggle}
      type="button"
    >
      {label}
    </button>
  );

  if (!old || context?.full || !valid) return button;

  const details = formatTranscriptTimestampDetails(props.value!);
  return (
    <Tooltip
      content={
        <span className="grid grid-cols-[auto_auto] gap-x-3">
          <span>Local</span>
          <span>{details.local}</span>
          <span>UTC</span>
          <span>{details.utc}</span>
        </span>
      }
      placement="above"
    >
      {button}
    </Tooltip>
  );
}
