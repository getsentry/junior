import { describe, expect, it } from "vitest";

import {
  canAccessConversation,
  type ConversationReach,
} from "@/api/conversations/access";

let nextRoot = 0;

function reach(overrides: Partial<ConversationReach> = {}): ConversationReach {
  return {
    rootConversationId: `root:${nextRoot++}`,
    visibility: "public",
    ...overrides,
  };
}

// One case for each row in policies/conversation-access.md, and the edges
// that fall through to a deny.
const scenarios: [
  scenario: string,
  requester: ConversationReach,
  target: ConversationReach,
  allowed: boolean,
][] = [
  [
    "row 1: same tree, also a private tree",
    reach({ rootConversationId: "root:a", visibility: "private" }),
    reach({ rootConversationId: "root:a", visibility: "private" }),
    true,
  ],
  ["row 2: public target from a public requester", reach(), reach(), true],
  [
    "row 2: public target from a private requester",
    reach({ visibility: "private" }),
    reach(),
    true,
  ],
  [
    "row 3: private target from a private requester",
    reach({ visibility: "private" }),
    reach({ visibility: "private" }),
    false,
  ],
  [
    "row 3: private target from a public requester",
    reach(),
    reach({ visibility: "private" }),
    false,
  ],
  [
    "row 3: a direct message target",
    reach({ visibility: "private" }),
    reach({ visibility: "direct" }),
    false,
  ],
  [
    "unknown target visibility is private",
    reach(),
    reach({ visibility: "unknown" }),
    false,
  ],
  [
    "a target with a missing root or Destination",
    reach(),
    reach({ rootConversationId: undefined, visibility: null }),
    false,
  ],
];

describe("canAccessConversation", () => {
  it.each(scenarios)("%s", (_scenario, requester, target, allowed) => {
    expect(canAccessConversation({ requester, target })).toBe(allowed);
  });
});
