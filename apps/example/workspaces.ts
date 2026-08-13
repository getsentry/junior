import { defineJuniorWorkspaces } from "@sentry/junior";

export const workspaces = defineJuniorWorkspaces([
  {
    id: "junior",
    name: "junior",
    setupScript: "",
    repos: [
      {
        provider: "github",
        repo: "getsentry/junior",
        checkoutPath: "junior",
        isPrimary: true,
      },
    ],
  },
]);
