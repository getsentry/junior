import { describe } from "vitest";
import { mention, rubric, slackEval } from "../helpers";

describe("Output Contract", () => {
  slackEval(
    "when asked for a structured overview, use bolded section labels instead of markdown headings",
    {
      events: [
        mention(
          "Give me a short overview of how OAuth 2.0 authorization code flow works. Cover the authorization request, token exchange, and refresh. Keep it to a few short sections.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        contract:
          "Structured multi-section replies use Slack-friendly bolded section labels, not markdown heading syntax.",
        pass: [
          "The assistant posts one reply that covers the authorization request, token exchange, and refresh.",
          "Section labels appear as bolded short phrases on their own line, not as markdown headings.",
        ],
        fail: [
          "Do not use markdown heading syntax (lines beginning with `#`, `##`, or `###`) for section labels.",
          "Do not paste a heading line like `# Authorization Request` at the start of a section.",
        ],
      }),
    },
  );

  slackEval(
    "when the reply contains multiple URLs, use plain URLs instead of markdown link syntax",
    {
      events: [
        mention(
          "Where can I find the official documentation for the Slack Web API, Slack Bolt JS, and Slack Block Kit? Just point me at the three canonical starting pages.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        contract:
          "URLs in Slack replies render as plain URLs, not markdown hyperlinks.",
        pass: [
          "The assistant posts one reply that names the three documentation starting points.",
          "Each URL appears as a bare URL in the reply text, not wrapped in markdown link syntax.",
        ],
        fail: [
          "Do not render any URL using `[label](url)` markdown link syntax.",
          "Do not wrap URLs in Slack `<url|label>` link syntax unless the user explicitly asked for that form.",
        ],
      }),
    },
  );

  slackEval(
    "when asked to compare two options, use bullets instead of a markdown table",
    {
      events: [
        mention(
          "Give me a short comparison of REST and GraphQL across these three dimensions: caching, over-fetching, and tooling maturity. Keep it tight.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        contract:
          "Comparative Slack replies present structured data with bullets or bolded labels rather than markdown tables.",
        pass: [
          "The assistant posts one reply that compares REST and GraphQL across caching, over-fetching, and tooling maturity.",
          "The comparison is expressed through bullets or bolded labels with short explanations, not a table.",
        ],
        fail: [
          "Do not render the comparison as a markdown table with pipe (`|`) column separators and dashed header rows.",
          "Do not include a row like `| REST | GraphQL |` or similar pipe-delimited structures.",
        ],
      }),
    },
  );
});
