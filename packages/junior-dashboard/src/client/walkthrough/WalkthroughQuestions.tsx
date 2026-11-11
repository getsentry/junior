import { ConversationComposer } from "../conversations/ConversationComposer";

const noSubmit = async () => {};

/**
 * Questions beside the story. The panel always shows on wide screens, so the
 * reader sees that they can ask at any chapter. Asking is not built yet.
 */
export function WalkthroughQuestions() {
  return (
    <aside
      aria-label="Questions"
      className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] border-l border-dashboard-border bg-dashboard-bg-elevated max-xl:hidden"
    >
      <h2 className="m-0 border-b border-dashboard-border-subtle px-4 py-3 font-sans text-sm font-semibold text-dashboard-text">
        Questions
      </h2>
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
    </aside>
  );
}
