import { createContext } from "react";

import type { WaitingConversation } from "../inbox/queries";
import type { Conversation } from "../types";

/** What rows deep in the Lead transcript read from the Lead page. */
type LeadPageValue = {
  /** The viewer's root Conversations, by id. */
  conversations: ReadonlyMap<string, Conversation>;
  /** Put text in the Lead's reply box, such as for "Message it". */
  prefill(text: string): void;
  /**
   * Open Inbox items that wait on the viewer, by Conversation id. Undefined
   * until they load.
   */
  waiting: ReadonlyMap<string, WaitingConversation> | undefined;
  /** The Conversations that the Lead has an active Watch on. */
  watchedIds: ReadonlySet<string>;
};

/** The Lead page around its transcript. Null outside the Lead. */
export const LeadPage = createContext<LeadPageValue | null>(null);
