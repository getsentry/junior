import { useSyncExternalStore, type ReactNode } from "react";

import { DetailsPanel } from "../components/DetailsPanel";

const defaultOpenMediaQuery = "(min-width: 1440px)";

function subscribeToDefaultLayout(onChange: () => void) {
  const media = window.matchMedia(defaultOpenMediaQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Open Conversation details by default only when the chat remains wide. */
export function useConversationDetailsDefaultOpen(): boolean {
  return useSyncExternalStore(
    subscribeToDefaultLayout,
    () => window.matchMedia(defaultOpenMediaQuery).matches,
    () => false,
  );
}

/** Add Conversation actions and a title to the shared responsive frame. */
export function ConversationDetailsFrame(props: {
  actions?: ReactNode;
  children: ReactNode;
  onClose(): void;
}) {
  return (
    <DetailsPanel
      actions={props.actions}
      label="Conversation details"
      onClose={props.onClose}
      title={
        <h2
          aria-label="Conversation details"
          className="m-0 text-base font-semibold text-dashboard-text"
        >
          Details
        </h2>
      }
    >
      {props.children}
    </DetailsPanel>
  );
}
