import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import {
  completedToolCalls,
  toolCallsOf,
  type ToolCall,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";
import { mockWebPages, mockWebSearchResults } from "@junior-evals/fixture/web";

/** Calls of a tool that the model made itself, not in a script. */
function directCalls(name: string, result: { toolCalls: ToolCall[] }): number {
  return result.toolCalls.filter((call) => call.name === name).length;
}

// The user never names codemode. These cases measure whether Junior picks a
// script when one call per item would be many calls, and skips it for one
// call.
describe("Code Mode Scripts", () => {
  test("when a request needs one call for each of many items, make the calls in one script", async ({
    run,
  }) => {
    const urls = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map(
      (name) => `https://example.com/services/${name}`,
    );
    // Each owner is only on its own page, so each page must be read.
    mockWebPages(
      Object.fromEntries(
        urls.map((url, index) => [
          url,
          `<html><body><h1>Service ${index + 1}</h1><p>Owner: team-${index * 7 + 3}</p></body></html>`,
        ]),
      ),
    );
    const conversation = await run(
      slackMention(
        `Who owns each of these services? Check each page:\n${urls.join("\n")}\nOne line each.`,
      ),
    );

    expect(completedToolCalls("codemode", conversation).length).toBeGreaterThan(
      0,
    );
    // The script reads the pages, so few of them are direct calls.
    expect(directCalls("webFetch", conversation)).toBeLessThan(urls.length);
    expect(conversation.replies).toHaveLength(1);
  });

  test("when a search selects the pages to read, read them in one script", async ({
    run,
  }) => {
    const releases = ["3.0", "3.1", "3.2", "3.3"].map((version) => ({
      version,
      url: `https://example.com/acme-cli/releases/${version}`,
    }));
    // The excerpts leave out the answer, so each page must be read.
    mockWebSearchResults(
      releases.map(({ version, url }) => ({
        title: `Acme CLI ${version} release notes`,
        url,
        excerpt: `Release notes for Acme CLI ${version}.`,
      })),
    );
    mockWebPages(
      Object.fromEntries(
        releases.map(({ version, url }) => [
          url,
          `<html><body><h1>Acme CLI ${version}</h1><p>Breaking change: ${version} removes the --legacy-${version} flag.</p></body></html>`,
        ]),
      ),
    );
    const conversation = await run(
      slackMention(
        "Look up the Acme CLI 3.x release notes on the web and tell me the breaking change in each release. One line per release.",
      ),
    );

    expect(completedToolCalls("codemode", conversation).length).toBeGreaterThan(
      0,
    );
    // The script reads the pages, so few of them are direct calls.
    expect(directCalls("webFetch", conversation)).toBeLessThan(releases.length);
    expect(conversation.replies).toHaveLength(1);
  });

  test("when one tool call answers the request, call the tool directly without a script", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("what time is it right now in UTC?"),
    );

    expect(toolCallsOf("codemode", conversation)).toEqual([]);
    expect(
      completedToolCalls("systemTime", conversation).length,
    ).toBeGreaterThan(0);
    expect(conversation.replies).toHaveLength(1);
  });
});
