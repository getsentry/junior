import { readFileSync } from "node:fs";
import { describeEval } from "vitest-evals";
import { pullRequestDescriptionCheckEvals } from "../../src/pr-description-check-harness";

// Drafts and finals of getsentry/junior PRs. A draft is the first body the
// agent wrote. A final is the body after review, without the footer.
function body(name: string): string {
  return readFileSync(
    new URL(`./fixtures/pr-descriptions/${name}.md`, import.meta.url),
    "utf8",
  );
}

const CHECKS = "check results";
const WORK_LOG = "work log";
const FILE_LIST = "file list";
const CONVERSATION = "conversation";
const REASON = "why the change is needed";

describeEval(
  "Pull Request Description Checks",
  pullRequestDescriptionCheckEvals,
  (it) => {
    it("when a draft is an investigation report with local checks, it rejects the work log and the checks", async ({
      run,
    }) => {
      await run({ body: body("pr-2420-draft"), reject: [WORK_LOG, CHECKS] });
    });

    it("when a draft lists every changed path and its checks, it rejects the file list and the checks", async ({
      run,
    }) => {
      await run({ body: body("pr-2461-draft"), reject: [FILE_LIST, CHECKS] });
    });

    it("when a draft explains how a tool name was chosen, it rejects the work log", async ({
      run,
    }) => {
      await run({ body: body("pr-3204-draft"), reject: [WORK_LOG] });
    });

    it("when a draft ends with local test runs, it rejects the checks", async ({
      run,
    }) => {
      await run({ body: body("pr-2668-draft"), reject: [CHECKS] });
    });

    for (const pr of ["2379", "2442"]) {
      it(`when a reviewed body still has a Checks section (#${pr}), it rejects the checks`, async ({
        run,
      }) => {
        await run({ body: body(`pr-${pr}-final`), reject: [CHECKS] });
      });
    }

    for (const pr of ["2420", "2461", "2959", "3204", "2668"]) {
      it(`when a body passed review (#${pr}), it accepts it`, async ({
        run,
      }) => {
        await run({ body: body(`pr-${pr}-final`), reject: false });
      });
    }

    it("when a body has a test plan, it rejects the checks", async ({
      run,
    }) => {
      await run({
        body: "Webhook deliveries that time out are now retried up to 5 times with backoff instead of being dropped, so a slow receiver no longer loses events.\n\n## Test plan\n\n- [x] Unit tests for the retry schedule\n- [x] Sent a delivery to a receiver that sleeps for 30s",
        reject: [CHECKS],
      });
    });

    it("when a body retells the chat that asked for it, it rejects the conversation", async ({
      run,
    }) => {
      await run({
        body: "Dana asked in the #ops Slack thread for the deploy script to stop reading the token from a file. The script now reads `DEPLOY_TOKEN` from the environment and exits with an error when it is unset, so the token no longer sits on disk.",
        reject: [CONVERSATION],
      });
    });

    it("when a body says what changed but not why, it asks for the reason", async ({
      run,
    }) => {
      await run({
        body: "Rename `retryLimit` to `maxRetries` in the webhook config.",
        reject: [REASON],
      });
    });

    it("when a body says what changed, why, and what breaks, it accepts it", async ({
      run,
    }) => {
      await run({
        body: "Rename `SANDBOX_TIMEOUT` to `JUNIOR_SANDBOX_TIMEOUT_MS` so it matches the other settings and states its unit.\n\n**Breaking:** the old name is no longer read. Set `JUNIOR_SANDBOX_TIMEOUT_MS` before you deploy, or sandboxes fall back to the 5 minute default.\n\nFixes #2233",
        reject: false,
      });
    });
  },
);
