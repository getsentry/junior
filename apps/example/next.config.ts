import { withJunior } from "@sentry/junior/config";
import path from "node:path";

export default withJunior(
  {
    pluginPackages: [
      "@sentry/junior-agent-browser",
      "@sentry/junior-github",
      "@sentry/junior-notion",
      "@sentry/junior-sentry",
    ],
  },
  {
    turbopack: {
      root: path.resolve(__dirname, "../.."),
    },
  },
);
