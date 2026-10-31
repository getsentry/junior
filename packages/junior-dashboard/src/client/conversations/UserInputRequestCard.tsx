import { formatUserInputAnswer } from "@sentry/junior/api/schema";

import { UserInputForm } from "../components/UserInputForm";
import { TranscriptText } from "./TranscriptText";
import type { OpenUserInputRequest } from "./userInputRequest";

/**
 * Show Junior's open request above the composer. The answer goes as the
 * reader's next message. Typing a reply also answers it.
 */
export function UserInputRequestCard(props: {
  onAnswer(answer: string): Promise<void>;
  request: OpenUserInputRequest;
}) {
  return (
    <section
      aria-label="Junior asks"
      className="mb-2 rounded-lg border border-cyan-300/20 bg-cyan-300/[0.07] px-3 py-2.5 font-sans text-sm text-dashboard-text"
    >
      <div className="max-h-48 overflow-y-auto">
        <TranscriptText
          mentions={[]}
          role="assistant"
          text={props.request.question}
        />
      </div>
      {/* Above the composer, a long form scrolls so the transcript stays visible. */}
      <div className="max-h-96 overflow-y-auto">
        <UserInputForm
          onSubmit={(answer) =>
            props.onAnswer(formatUserInputAnswer(props.request, answer))
          }
          request={props.request}
          requestId={props.request.toolCallId}
        />
      </div>
    </section>
  );
}
