import { ConversationComposer } from "../conversations/ConversationComposer";

const noSubmit = async () => {};

/** Questions beside the story. Asking is not built yet. */
export function WalkthroughQuestions() {
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]">
      <div className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain px-4 py-4 text-sm text-dashboard-text-muted">
        Asking about a Walkthrough is not available yet.
      </div>
      <div className="px-3 pt-2 pb-2">
        <ConversationComposer
          compact
          disabled
          draftId="walkthrough:questions"
          label="Question"
          onSubmit={noSubmit}
          placeholder="Ask a question…"
          submitLabel="Ask"
        />
      </div>
    </div>
  );
}
