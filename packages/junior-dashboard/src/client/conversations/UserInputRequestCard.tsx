import { useState } from "react";

import { Button } from "../components/Button";
import { TranscriptText } from "./TranscriptText";
import type { OpenUserInputRequest } from "./userInputRequest";

/**
 * Show Junior's open question with one button per choice. A click sends the
 * choice label as the reader's next message. Typing a reply also answers it.
 */
export function UserInputRequestCard(props: {
  onAnswer(answer: string): Promise<void>;
  request: OpenUserInputRequest;
}) {
  const [sending, setSending] = useState<string>();
  const [failed, setFailed] = useState(false);

  async function answer(label: string) {
    setSending(label);
    setFailed(false);
    try {
      await props.onAnswer(label);
    } catch {
      setFailed(true);
    } finally {
      setSending(undefined);
    }
  }

  return (
    <section
      aria-label="Junior asks"
      className="mb-2 rounded-lg border border-cyan-300/20 bg-cyan-300/[0.07] px-3 py-2.5 font-sans text-sm text-dashboard-text"
    >
      <div className="max-h-48 overflow-y-auto">
        <TranscriptText role="assistant" text={props.request.question} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {props.request.options.map((option) => (
          <Button
            disabled={sending !== undefined}
            key={option.label}
            onClick={() => void answer(option.label)}
            title={option.description}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {props.request.options.some((option) => option.description) ? (
        <ul className="mb-0 mt-2 list-none p-0 text-xs text-dashboard-text-muted">
          {props.request.options
            .filter((option) => option.description)
            .map((option) => (
              <li key={option.label}>
                <span className="font-medium text-dashboard-text">
                  {option.label}
                </span>
                : {option.description}
              </li>
            ))}
        </ul>
      ) : null}
      {failed ? (
        <p className="mb-0 mt-2 text-xs text-rose-300" role="alert">
          Could not send your answer. Try again.
        </p>
      ) : null}
    </section>
  );
}
