import { Mic, Square, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { cn } from "../styles";
import {
  DICTATION_MAX_SECONDS,
  dictationSupported,
  type Dictation,
} from "./useDictation";

// Warn before the recording stops on its own.
const DICTATION_WARN_SECONDS = DICTATION_MAX_SECONDS - 10;

type ComposerDictationProps = {
  dictation: Dictation;
  disabled?: boolean;
};

/** Mic button for the composer. Puts dictated text into the draft; it never sends. */
export function ComposerDictation({
  dictation,
  disabled,
}: ComposerDictationProps) {
  const [supported] = useState(dictationSupported);
  const { cancel } = dictation;
  const listening =
    dictation.state === "starting" || dictation.state === "recording";

  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, listening]);

  if (!supported) return null;

  // Show the recording controls on click. The dot turns red only when the
  // mic is live, because opening the device can take a moment.
  if (listening) {
    const live = dictation.state === "recording";
    return (
      <div className="flex items-center gap-1">
        {live ? (
          <RecordingTime />
        ) : (
          <DictationStatus dotClassName="bg-dashboard-border-interactive">
            Starting
          </DictationStatus>
        )}
        <Button
          aria-label="Cancel dictation"
          onClick={dictation.cancel}
          size="icon"
          type="button"
          variant="danger"
        >
          <X aria-hidden="true" size={16} />
        </Button>
        <Button
          aria-label="Stop and transcribe"
          disabled={!live}
          onClick={dictation.stop}
          size="icon"
          type="button"
        >
          <Square
            aria-hidden="true"
            className="text-rose-400"
            fill="currentColor"
            size={12}
          />
        </Button>
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            focusableWhenDisabled
            aria-label={
              dictation.state === "transcribing" ? "Transcribing" : "Dictate"
            }
            disabled={disabled || dictation.state !== "idle"}
            onClick={() => void dictation.start()}
            size="icon"
            type="button"
          >
            {dictation.state === "transcribing" ? (
              <Spinner aria-hidden="true" role={undefined} />
            ) : (
              <Mic aria-hidden="true" size={16} />
            )}
          </Button>
        }
      />
      <TooltipContent size="compact">
        Dictate (up to {DICTATION_MAX_SECONDS / 60} minutes)
      </TooltipContent>
    </Tooltip>
  );
}

// Ticks on its own, so only this label renders each second.
function RecordingTime() {
  const [startedAt] = useState(Date.now);
  const [now, setNow] = useState(startedAt);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = Math.floor((now - startedAt) / 1000);
  return (
    <DictationStatus
      dotClassName="bg-rose-400"
      warn={seconds >= DICTATION_WARN_SECONDS}
    >
      <span className="sr-only">Recording </span>
      {formatSeconds(seconds)}
    </DictationStatus>
  );
}

function DictationStatus(props: {
  children: ReactNode;
  dotClassName: string;
  warn?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 px-1 font-sans text-xs tabular-nums",
        props.warn ? "text-rose-300" : "text-dashboard-text-muted",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 rounded-full", props.dotClassName)}
      />
      {props.children}
    </span>
  );
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
