import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DisplayText,
  KnownObjectsProvider,
} from "../src/client/display-text/DisplayText";
import { textHasStandaloneUrl } from "../src/client/display-text/knownObjects";
import { displayPlainText } from "../src/client/display-text/plainText";

// Links can ask the API for cards, so display text needs a query client.
function markup(children: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>,
  );
}

function renderedLinks(text: string) {
  const html = markup(<DisplayText text={text} />);
  return {
    html,
    links: [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map(
      // Drop the outbound icon so labels compare as text.
      ([, href, label]) => ({
        href,
        label: label?.replace(/<svg.*<\/svg>/, ""),
      }),
    ),
  };
}

describe("display text links", () => {
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

describe("display text tokens", () => {
  const mentions = [{ fullName: "Junior", slackUserId: "U0BOT" }];
  const text =
    "**Done** :smile: <@U0BOT> see <https://example.com/pr|the PR> :wave::skin-tone-3: :custom_parrot:";

  it("renders Slack mentions, links, and emoji the same way in each mode", () => {
    const block = markup(<DisplayText mentions={mentions} text={text} />);
    const inline = markup(
      <DisplayText inline mentions={mentions} text={text} />,
    );

    for (const html of [block, inline]) {
      expect(html).toContain("<strong");
      expect(html).toContain("@Junior");
      expect(html).toContain("😄");
      expect(html).toContain("👋🏼");
      // Workspace emoji are not in the dataset, so they stay as text.
      expect(html).toContain(":custom_parrot:");
      expect(html).toContain("the PR");
      expect(html).not.toContain("U0BOT&gt;");
    }
    expect(block).toContain('href="https://example.com/pr"');
    // Inline text can sit in a button or a card link, so it has no links.
    expect(inline).not.toContain("<a ");
    expect(inline).not.toMatch(/<(p|div|ul|li|h\d)[\s>]/);
  });

  it("keeps emoji codes literal inside code", () => {
    const html = markup(<DisplayText text="Use `:smile:`." />);

    expect(html).toContain(":smile:");
    expect(html).not.toContain("😄");
  });

  it("returns the same names and emoji as plain text", () => {
    expect(displayPlainText(text, mentions)).toBe(
      "Done 😄 @Junior see the PR 👋🏼 :custom_parrot:",
    );
  });
});

describe("display text object links", () => {
  const PR = "https://github.com/acme/app/pull/7";
  const annotations = [
    {
      createdAt: "2026-08-07T08:00:00.000Z",
      displayType: "Pull request",
      key: "acme/app#7",
      kind: "object" as const,
      label: "acme/app#7",
      objectType: "code_change" as const,
      plugin: "github",
      status: "open",
      title: "Retry checkout writes",
      updatedAt: "2026-08-07T08:00:00.000Z",
      url: PR,
    },
  ];

  function render(text: string) {
    return markup(
      <KnownObjectsProvider annotations={annotations}>
        <DisplayText text={text} />
      </KnownObjectsProvider>,
    );
  }

  it("shows a bare URL in a sentence or a list as a chip", () => {
    for (const text of [`Opened ${PR} for review.`, `- ${PR}`, `> ${PR}`]) {
      const html = render(text);
      expect(html).toContain(`href="${PR}"`);
      expect(html).toContain("acme/app#7");
      expect(html).toContain("· Open");
      expect(html).not.toContain(">Retry checkout writes<");
      expect(html).not.toContain(`>${PR}<`);
    }
  });

  it("shows a bare URL alone in a paragraph as the object row", () => {
    for (const text of [`Done.\n\n${PR}/\n\nThanks.`, `<${PR}>`]) {
      const html = render(text);
      expect(html).toContain(
        'aria-label="Pull request: Retry checkout writes"',
      );
      expect(html).toContain("acme/app#7");
    }
  });

  it("keeps the text of a labeled link", () => {
    const html = render(`See [the fix](${PR}).`);
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/github.com\/acme\/app\/pull\/7"[^>]*>the fix/,
    );
    expect(html).not.toContain("acme/app#7");
    expect(html).not.toContain('aria-label="Pull request: ');
  });

  it("leaves links to unknown objects and other pages plain", () => {
    for (const url of [
      "https://github.com/acme/app/pull/8",
      `${PR}#discussion_r1`,
      `${PR}/files`,
    ]) {
      for (const text of [`See ${url} now.`, url]) {
        const html = render(text);
        expect(html).toContain(`>${url}<`);
        expect(html).not.toContain("acme/app#7");
      }
    }
  });

  it("finds a bare URL alone in a paragraph outside code fences", () => {
    expect(textHasStandaloneUrl(`Ready.\n\n${PR}`, PR)).toBe(true);
    expect(textHasStandaloneUrl(`<${PR}/>`, PR)).toBe(true);
    expect(textHasStandaloneUrl(`Ready: ${PR}`, PR)).toBe(false);
    expect(textHasStandaloneUrl(`[PR](${PR})`, PR)).toBe(false);
    expect(textHasStandaloneUrl("```\n" + PR + "\n```", PR)).toBe(false);
    expect(textHasStandaloneUrl(`Ready.\n\n    ${PR}`, PR)).toBe(false);
    expect(textHasStandaloneUrl(`Ready.\n\n\t${PR}`, PR)).toBe(false);
  });
});
