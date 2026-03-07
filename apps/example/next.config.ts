import { withJunior } from "@sentry/junior/config";
import path from "node:path";

export default withJunior({
  turbopack: {
    root: path.resolve(__dirname, "../..")
  }
});
