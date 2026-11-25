import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { ConversationSidebarThreadRow } from "../src/client/conversations/ConversationSidebarThreadRow";
import type { Conversation } from "../src/client/types";

const AT = "2026-01-01T10:00:00.000Z";

/** An open action item reads `needs_input` while a Turn runs. */
function runningNeedsInput(kind: Conversation["kind"]): Conversation {
  return {
    cumulativeDurationMs: 0,
    displayTitle: "Roll out payments",
    id: `internal:${kind}`,
    isParticipant: true,
    kind,
    lastProgressAt: AT,
    lastSeenAt: AT,
    startedAt: AT,
    status: "needs_input",
    surface: "internal",
    turnActive: true,
  };
}

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

// The feed card needs a DOM, so the e2e "a running row that needs input
// shows both" covers it.
describe("a running Thread row that needs input", () => {
  it("shows both on a Thread row", () => {
    const markup = render(
      <ConversationSidebarThreadRow
        conversation={runningNeedsInput("root")}
        depth={0}
        onArchiveError={() => {}}
        onArchived={() => {}}
        selected={false}
      />,
    );
    expect(markup).toContain('aria-label="Running"');
    expect(markup).toContain('aria-label="Needs input"');
  });

  it("shows one spinner on a working Thread row", () => {
    const markup = render(
      <ConversationSidebarThreadRow
        conversation={{ ...runningNeedsInput("root"), status: "working" }}
        depth={0}
        onArchiveError={() => {}}
        onArchived={() => {}}
        selected={false}
      />,
    );
    expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(markup).not.toContain("Needs input");
  });
});
