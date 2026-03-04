import { withWorkflow } from "workflow/next";
import { withJunior } from "@/next-config";

const nextConfig = withWorkflow({
  typedRoutes: true,
  turbopack: {
    root: process.cwd()
  }
});

export default withJunior(nextConfig, { sentry: true });
