import { createContext, useContext, useState, type ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import {
  formatMessageTimestamp,
  formatTranscriptMessageTime,
  formatTranscriptTimestampDetails,
} from "../format";

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
  const label = context?.full
    ? formatMessageTimestamp(props.value, true)
    : formatTranscriptMessageTime(props.value);

  const button = (
    <button
      className="cursor-pointer border-0 bg-transparent p-0 font-inherit text-inherit"
      onClick={context?.toggle}
      type="button"
    >
      {label}
    </button>
  );

  if (context?.full || !valid) return button;

  const details = formatTranscriptTimestampDetails(props.value!);
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>
        <span className="grid grid-cols-[auto_auto] gap-x-3">
          <span>Local</span>
          <span>{details.local}</span>
          <span>UTC</span>
          <span>{details.utc}</span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
