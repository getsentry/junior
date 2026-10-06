import { describe, expect } from "vitest";
import { mention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

describe("Output Contract", () => {
  test("when asked for a structured overview, avoid hash markdown headings", async ({
    run,
  }) => {
    const conversation = await run(
      mention(
        "Give me a short overview of how OAuth 2.0 authorization code flow works. Cover the authorization request, token exchange, and refresh. Keep it to a few short sections.",
      ),
    );
    await expect(conversation.evalRun).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant posts one reply that covers the authorization request, token exchange, and refresh.",
          "No section label line starts with `#`, `##`, or `###`.",
        ],
        fail: [
          "Do not use lines beginning with `#`, `##`, or `###` for section labels.",
          "Do not paste a hash-heading line like `# Authorization Request` at the start of a section.",
        ],
      }),
    );
  });

  test("when asked for documentation, link to each official starting page", async ({
    run,
  }) => {
    const conversation = await run(
      mention(
        "Where can I find the official documentation for the Slack Web API, Slack Bolt JS, and Slack Block Kit? Just point me at the three canonical starting pages.",
      ),
    );
    await expect(conversation.evalRun).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant posts one reply that names the three documentation starting points.",
          "Each starting point includes a link to the corresponding official Slack documentation. Descriptive labels, URL labels, and bare URLs are all acceptable.",
        ],
        fail: [
          "Do not omit a requested documentation link or substitute an unofficial site.",
        ],
      }),
    );
  });

  test("when asked to compare two options, use bullets instead of a markdown table", async ({
    run,
  }) => {
    const conversation = await run(
      mention(
        "Give me a short comparison of REST and GraphQL across these three dimensions: caching, over-fetching, and tooling maturity. Keep it tight.",
      ),
    );
    await expect(conversation.evalRun).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant posts one reply that compares REST and GraphQL across caching, over-fetching, and tooling maturity.",
          "The comparison is expressed through bullets or bolded labels with short explanations, not a table.",
        ],
        fail: [
          "Do not render the comparison as a markdown table with pipe (`|`) column separators and dashed header rows.",
          "Do not include a row like `| REST | GraphQL |` or similar pipe-delimited structures.",
        ],
      }),
    );
  });
});
