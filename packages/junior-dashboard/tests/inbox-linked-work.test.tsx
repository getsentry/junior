import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  InboxLinkedWorkChips,
  WorkLine,
} from "../src/client/review-desk/InboxLinkedWork";

// The visible text of rendered markup: its text nodes, in order.
function text(markup: string): string {
  return [...markup.matchAll(/>([^<]+)</g)].map((match) => match[1]).join("");
}

describe("linked work short names", () => {
  it("keeps the short name when the title is only part of it", () => {
    const line = renderToStaticMarkup(
      <WorkLine
        main={undefined}
        work={{
          key: "ENG-123",
          label: "ENG-123",
          objectType: "task",
          title: "123",
        }}
      />,
    );
    expect(text(line)).toBe("123ENG-123");

    const chips = renderToStaticMarkup(
      <InboxLinkedWorkChips
        annotations={[
          {
            key: "getsentry/junior#1",
            label: "junior",
            objectType: "code_change",
            title: "1",
            url: "https://github.com/getsentry/junior/pull/1",
          },
        ]}
      />,
    );
    // The chip shows the number; its title is its accessible name.
    expect(text(chips)).toBe("1 #1");
  });

  it("names a web page once when its label repeats its title", () => {
    const title = "Checkout 4.2 brings back per-session tax caching";
    for (const label of [title, `${title} · Example News`, "Checkout 4.2…"]) {
      const line = renderToStaticMarkup(
        <WorkLine
          main={undefined}
          work={{
            key: "https://news.example.com/checkout",
            label,
            objectType: "web_page",
            title,
          }}
        />,
      );
      expect(text(line)).toBe(title);
    }
  });
});
