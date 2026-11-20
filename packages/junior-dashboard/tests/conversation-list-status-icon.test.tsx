import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ConversationListStatusIcon,
  ConversationStatusText,
} from "../src/client/conversations/ConversationListStatusIcon";

describe("conversation row status", () => {
  it("shows a running Turn and needs input on the same row", () => {
    // An open action item reads `needs_input` while a Turn runs.
    const markup = renderToStaticMarkup(
      <>
        <ConversationListStatusIcon turnActive waitingOnViewer />
        <ConversationStatusText isPrivate={false} status="needs_input" />
      </>,
    );
    expect(markup).toContain('aria-label="Running"');
    expect(markup).toContain("Needs input");
    expect(markup).not.toContain("Waiting on you");
  });

  it("shows no spinner when no Turn runs", () => {
    const markup = renderToStaticMarkup(
      <ConversationListStatusIcon turnActive={false} waitingOnViewer />,
    );
    expect(markup).not.toContain('aria-label="Running"');
    expect(markup).toContain("Waiting on you");
  });
});
