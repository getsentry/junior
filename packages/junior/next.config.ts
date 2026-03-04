import { withJunior } from "@/next-config";
import path from "node:path";
import { withWorkflow } from "workflow/next";

const nextConfig = {
  typedRoutes: true,
  turbopack: {
    root: path.resolve(process.cwd(), "../..")
  }
};

export default withWorkflow(withJunior(nextConfig, { sentry: true }));
