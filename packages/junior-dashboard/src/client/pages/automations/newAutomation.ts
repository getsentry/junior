import type { AutomationSummary } from "@sentry/junior/api/schema";
import { useNavigate } from "react-router";

import type { PaneNewAction } from "../../components/layout/PaneNav";
import {
  restoreStoredDraftText,
  takeStoredDraftText,
} from "../../conversations/ConversationComposer";
import {
  FOCUS_REPLY_STATE,
  NEW_CONVERSATION_PATH,
} from "../../conversations/conversationRoutes";
import { automationPath } from "../../format";

const NEW_AUTOMATION_PROMPT = "Set up an automation that ";

/** The list the Automations page reads. The command palette reads it too, from the cache. */
export const AUTOMATION_LIST_SEARCH = "pageSize=100";

/**
 * New on the Automations pages. The dashboard has no Automation form:
 * Junior sets one up from a Conversation, so New starts one with the ask
 * typed in.
 */
export function useNewAutomationAction(): PaneNewAction {
  const navigate = useNavigate();
  return {
    label: "New automation",
    onClick() {
      const draft = takeStoredDraftText("new");
      restoreStoredDraftText(
        "new",
        draft.startsWith(NEW_AUTOMATION_PROMPT)
          ? draft
          : `${NEW_AUTOMATION_PROMPT}${draft}`,
      );
      navigate(NEW_CONVERSATION_PATH, { state: FOCUS_REPLY_STATE });
    },
  };
}

/** Where the palette opens an Automation: its editor, unless it cannot change. */
export function automationSelectPath(automation: AutomationSummary): string {
  return automation.status === "completed"
    ? automationPath(automation.id)
    : automationPath(automation.id, "edit");
}
