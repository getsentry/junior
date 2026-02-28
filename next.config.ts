import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { withJunior } from "@/next-config";

const nextConfig: NextConfig = withWorkflow({
  typedRoutes: true,
  turbopack: {
    root: process.cwd()
  }
});

export default withJunior(nextConfig, { home: "./jr-sentry", sentry: true });
