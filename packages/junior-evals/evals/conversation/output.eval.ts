import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";

describeEval("Output Contract", slackEvals, (it) => {
  it("when a task has several explicit deliverables, preserve all of them in the proposed scope", async ({
    run,
  }) => {
    await run({
      initialEvents: [
        mention(
          "Before touching code, summarize the scope you would implement for this ticket: register three new event tables in the warehouse sync, add a daily account summary that joins those events, and update the existing notification-provider definition. The daily summary is the largest part, but all three are required. Keep it brief.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The proposed scope preserves all three required deliverables: warehouse sync registration, the daily account summary, and the notification-provider definition update.",
          "The assistant does not remove the daily account summary merely because it is the largest deliverable.",
        ],
        fail: [
          "Do not label an explicit deliverable as out of scope or defer it to separate work without asking the user to approve that scope change.",
          "Do not present a partial implementation as the complete ticket.",
        ],
      }),
    });
  });

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

  it("when the reply contains multiple URLs, keep the full URLs visible instead of replacing them with labels", async ({
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
          "Each documentation link displays its full URL as the link text. Bare `https://...` and Slack `<https://...>` forms are both acceptable.",
        ],
        fail: [
          "Do not replace a full URL with a custom label using `[label](url)` or Slack `<url|label>` syntax.",
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
