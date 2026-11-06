import { Mic, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
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
  useDictation,
} from "./useDictation";

// Warn before the recording stops on its own.
const DICTATION_WARN_SECONDS = DICTATION_MAX_SECONDS - 10;

type ComposerDictationProps = {
  disabled?: boolean;
  onError(message: string | undefined): void;
  onText(text: string): void;
};

/** Mic button for the composer. Puts dictated text into the draft; it never sends. */
export function ComposerDictation(props: ComposerDictationProps) {
  const [supported] = useState(dictationSupported);
  const dictation = useDictation(props);
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

  if (dictation.state === "recording") {
    const warn = dictation.elapsedSeconds >= DICTATION_WARN_SECONDS;
    return (
      <div className="flex items-center gap-1">
        <span
          className={cn(
            "flex items-center gap-1.5 px-1 font-sans text-xs tabular-nums",
            warn ? "text-rose-300" : "text-dashboard-text-muted",
          )}
        >
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-rose-400"
          />
          <span className="sr-only">Recording </span>
          {formatSeconds(dictation.elapsedSeconds)}
        </span>
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

  const busy = dictation.state !== "idle";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            focusableWhenDisabled
            aria-label={
              dictation.state === "transcribing" ? "Transcribing" : "Dictate"
            }
            disabled={props.disabled || busy}
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

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
