import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  walkthroughVersionSchema,
  type WalkthroughDocument,
} from "@sentry/junior/api/schema";

import { CitedProse } from "../src/client/walkthrough/WalkthroughEvidence";
import { citedEvidence } from "../src/client/walkthrough/walkthroughModel";
import singleRun from "../src/mock-reporting/walkthroughs/pr3071.json";

const document = walkthroughVersionSchema.parse(singleRun)
  .document as WalkthroughDocument;

describe("Walkthrough citations", () => {
  it("numbers evidence in prose order and drops what the document lacks", () => {
    const refs = citedEvidence(document, [
      { kind: "link", label: "Sentry issue", url: "https://sentry.io/i/1" },
      { kind: "check", check_id: "missing" },
      { kind: "message", seq: 4 },
    ]);
    expect(refs).toEqual([
      {
        kind: "link",
        label: "Sentry issue",
        n: 1,
        url: "https://sentry.io/i/1",
      },
    ]);
  });

  it("renders citations as separated superscript marks", () => {
    const refs = citedEvidence(
      document,
      document.content.chapters[0]!.evidence,
    );
    const html = renderToStaticMarkup(
      <CitedProse
        onOpen={() => {}}
        openOnFocus
        refs={refs}
        text="It calls it[2][3][9]."
      />,
    );
    expect(html).toContain('aria-label="Evidence 2: list.ts:150"');
    expect(html).toContain(">,</span>");
    expect(html).not.toContain("[9]");
    expect(html).not.toContain("Evidence 9");
  });
});
