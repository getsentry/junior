import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";

describeEval("Output Contract", slackEvals, (it) => {
  it("when asked for a structured overview, avoid hash markdown headings", async ({
    run,
  }) => {
    await run({
      initialEvents: [
        mention(
          "Give me a short overview of how OAuth 2.0 authorization code flow works. Cover the authorization request, token exchange, and refresh. Keep it to a few short sections.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The assistant posts one reply that covers the authorization request, token exchange, and refresh.",
          "No section label line starts with `#`, `##`, or `###`.",
        ],
        fail: [
          "Do not use lines beginning with `#`, `##`, or `###` for section labels.",
          "Do not paste a hash-heading line like `# Authorization Request` at the start of a section.",
        ],
      }),
    });
  });

  it("when the reply contains multiple URLs, use plain URLs instead of markdown link syntax", async ({
    run,
  }) => {
    await run({
      initialEvents: [
        mention(
          "Where can I find the official documentation for the Slack Web API, Slack Bolt JS, and Slack Block Kit? Just point me at the three canonical starting pages.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The assistant posts one reply that names the three documentation starting points.",
          "Each URL appears as a bare URL in the reply text, not wrapped in markdown link syntax.",
        ],
        fail: [
          "Do not render any URL using `[label](url)` markdown link syntax.",
          "Do not wrap URLs in Slack `<url|label>` link syntax unless the user explicitly asked for that form.",
        ],
      }),
    });
  });

  it("when asked to compare two options, use bullets instead of a markdown table", async ({
    run,
  }) => {
    await run({
      initialEvents: [
        mention(
          "Give me a short comparison of REST and GraphQL across these three dimensions: caching, over-fetching, and tooling maturity. Keep it tight.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The assistant posts one reply that compares REST and GraphQL across caching, over-fetching, and tooling maturity.",
          "The comparison is expressed through bullets or bolded labels with short explanations, not a table.",
        ],
        fail: [
          "Do not render the comparison as a markdown table with pipe (`|`) column separators and dashed header rows.",
          "Do not include a row like `| REST | GraphQL |` or similar pipe-delimited structures.",
        ],
      }),
    });
  });
});
