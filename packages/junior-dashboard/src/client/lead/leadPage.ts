import { createContext } from "react";

import type { Conversation } from "../types";

/** What rows deep in the Lead transcript read from the Lead page. */
type LeadPageValue = {
  /** The root Conversations of the Space and of the viewer, by id. */
  conversations: ReadonlyMap<string, Conversation>;
};

/** The Lead page around its transcript. Null outside the Lead. */
export const LeadPage = createContext<LeadPageValue | null>(null);
