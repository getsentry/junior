/**
 * The Google suite: the Google plugin and no other plugin or skill.
 *
 * A suite is a Vitest project for one directory. It sets the default agent
 * options for its tests. See `src/fixture/test.ts`.
 */
import path from "node:path";

/** The Google Workspace account that Junior acts as in the suite. */
export const GOOGLE_ACCOUNT_EMAIL = "junior@example.com";

/** Project settings of the Google suite. The config adds `include`. */
export const googleSuite = {
  name: "google",
  // The host settings that turn on the Calendar tools. Slack people in the
  // fixture have `example.com` emails, which is also the domain of this
  // account, so Junior may check and invite them.
  env: {
    GOOGLE_CLIENT_ID: "eval-google-client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "eval-google-client-secret",
    GOOGLE_WORKSPACE_ACCOUNT_EMAIL: GOOGLE_ACCOUNT_EMAIL,
  },
  provide: {
    agentOptionsModule: path.resolve(__dirname, "google-agent-options.ts"),
  },
};
