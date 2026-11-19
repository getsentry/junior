import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { VERSIONS_CONVERSATION_LIMIT } from "@sentry/junior/api/schema";
import { describe, expect, it } from "vitest";

import { conversationDetailQueryKey } from "../src/client/conversations/queries";
import { onScreenConversationIds } from "../src/client/versions";

/** Cache an idle detail for each id and mount it, as a card on screen does. */
function mountDetails(client: QueryClient, ids: string[]) {
  for (const id of ids) {
    const queryKey = conversationDetailQueryKey(id);
    client.setQueryData(queryKey, { conversationId: id, events: [] });
    new QueryObserver(client, { enabled: false, queryKey }).subscribe(() => {});
  }
}

describe("versions poll Conversation ids", () => {
  it("asks for the same screen with the same sorted ids", () => {
    const client = new QueryClient();
    mountDetails(client, ["slack:C3", "slack:C1", "slack:C2"]);

    expect(onScreenConversationIds(client, "slack:C2")).toEqual([
      "slack:C1",
      "slack:C2",
      "slack:C3",
    ]);
  });

  it("keeps the open Conversation when more details than the cap are on screen", () => {
    const client = new QueryClient();
    const ids = Array.from(
      { length: VERSIONS_CONVERSATION_LIMIT + 5 },
      (_, index) => `slack:C${String(index).padStart(3, "0")}`,
    );
    mountDetails(client, ids);
    const open = ids.at(-1)!;

    const asked = onScreenConversationIds(client, open);

    expect(asked).toHaveLength(VERSIONS_CONVERSATION_LIMIT);
    expect(asked).toContain(open);
    expect(asked).toEqual([...asked].sort());
  });
});
