import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TranscriptMarkdown } from "../src/client/conversations/TranscriptMarkdown";

function renderedLinks(text: string) {
  const html = renderToStaticMarkup(<TranscriptMarkdown text={text} />);
  return {
    html,
    links: [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map(
      ([, href, label]) => ({ href, label }),
    ),
  };
}

describe("transcript markdown links", () => {
  it("links safe destinations and keeps only the label of unsafe ones", () => {
    const { html, links } = renderedLinks(
      'See [trace](https://sentry.example/trace), https://docs.example/path)., [local](/api/me), [titled](https://docs.example/titled "Docs"), [bad](javascript:https://unsafe.example), [data](data:text/html,hi), and ![pixel](javascript:alert(1)).',
    );

    expect(links).toEqual([
      { href: "https://sentry.example/trace", label: "trace" },
      {
        href: "https://docs.example/path",
        label: "https://docs.example/path",
      },
      { href: "https://docs.example/titled", label: "titled" },
    ]);
    expect(html).not.toMatch(/javascript:|data:|\/api\/me|<img/);
    expect(html).toContain("local");
    expect(html).toContain("bad");
    expect(html).toContain("pixel");
  });

  it("renders CommonMark autolinks without their angle-bracket syntax", () => {
    const { links } = renderedLinks(
      "See <https://docs.example/path> and <mailto:team@example.com>, but keep `<https://literal.example>` literal.",
    );

    expect(links).toEqual([
      {
        href: "https://docs.example/path",
        label: "https://docs.example/path",
      },
      { href: "mailto:team@example.com", label: "mailto:team@example.com" },
    ]);
  });

  it("does not let malformed nested labels swallow later valid links", () => {
    const { links } = renderedLinks(
      "See [broken [real](https://nested.example/ok).",
    );

    expect(links).toEqual([
      { href: "https://nested.example/ok", label: "real" },
    ]);
  });

  it("leaves links inside inline code and escaped link syntax literal", () => {
    const { html, links } = renderedLinks(
      "Use `[syntax](https://example.com)` and ``https://bare.example``, keep \\[literal](https://literal.example), but link [real](https://real.example) plus https://bare-real.example.",
    );

    // GFM still links the bare URL inside escaped link syntax, as GitHub does.
    expect(links).toEqual([
      {
        href: "https://literal.example",
        label: "https://literal.example",
      },
      { href: "https://real.example", label: "real" },
      {
        href: "https://bare-real.example",
        label: "https://bare-real.example",
      },
    ]);
    expect(html).toContain("[syntax](https://example.com)");
    expect(html).toContain("https://bare.example");
    expect(html).toContain("[literal](");
  });

  it("does not autolink bare URLs inside dropped link destinations", () => {
    const { links } = renderedLinks(
      "Ignore [local](/api/internal/https://internal.example), [bad](javascript:https://unsafe.example), and keep https://safe.example.",
    );

    expect(links).toEqual([
      { href: "https://safe.example", label: "https://safe.example" },
    ]);
  });

  it("keeps emphasis markers outside bare URLs", () => {
    expect(renderedLinks("see https://example.com**bold** here").links).toEqual(
      [{ href: "https://example.com", label: "https://example.com" }],
    );
    expect(renderedLinks("see <https://example.com/a*b> here").links).toEqual([
      { href: "https://example.com/a*b", label: "https://example.com/a*b" },
    ]);
  });
});
