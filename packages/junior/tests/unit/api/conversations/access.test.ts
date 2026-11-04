import { describe, expect, it } from "vitest";

import {
  canAccessConversation,
  type ConversationAccess,
} from "@/api/conversations/access";

const WORKSPACE = { provider: "slack", providerTenantId: "T1" };
let nextRoot = 0;

function access(
  overrides: Partial<ConversationAccess> = {},
): ConversationAccess {
  return {
    canViewPrivateContent: false,
    isParticipant: false,
    rootConversationId: `root:${nextRoot++}`,
    tenant: WORKSPACE,
    visibility: "public",
    ...overrides,
  };
}

// One row for each scenario in policies/conversation-access.md.
const scenarios: [
  scenario: string,
  requester: ConversationAccess,
  target: ConversationAccess,
  allowed: boolean,
][] = [
  [
    "same tree: a private tree, also when the person is not a participant",
    access({ rootConversationId: "root:a", visibility: "private" }),
    access({ rootConversationId: "root:a", visibility: "private" }),
    true,
  ],
  ["public target from a public requester", access(), access(), true],
  [
    "public target from a private requester",
    access({ visibility: "private" }),
    access(),
    true,
  ],
  [
    "public target in another workspace",
    access(),
    access({ tenant: { provider: "slack", providerTenantId: "T2" } }),
    false,
  ],
  [
    "private target where the person is a participant, from a private requester",
    access({ visibility: "private" }),
    access({ isParticipant: true, visibility: "private" }),
    true,
  ],
  [
    "private target where the person is a participant, from a public requester",
    access(),
    access({ isParticipant: true, visibility: "private" }),
    false,
  ],
  [
    "private target where the person is not a participant",
    access({ visibility: "private" }),
    access({ visibility: "private" }),
    false,
  ],
  [
    "private target in a Turn with no person",
    access({ visibility: "private" }),
    access({ visibility: "private" }),
    false,
  ],
  [
    "participant target with a missing root or Destination",
    access({ visibility: "private" }),
    access({ isParticipant: true, visibility: null }),
    false,
  ],
  [
    "participant private target from a requester with unknown visibility",
    access({ visibility: null }),
    access({ isParticipant: true, visibility: "private" }),
    false,
  ],
  [
    "requester with no workspace",
    access({ tenant: undefined }),
    access(),
    false,
  ],
];

describe("canAccessConversation", () => {
  it.each(scenarios)("%s", (_scenario, requester, target, allowed) => {
    expect(canAccessConversation({ requester, target })).toBe(allowed);
  });
});
