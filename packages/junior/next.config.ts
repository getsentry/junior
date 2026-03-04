import { withJunior } from "@/next-config";
import path from "node:path";

const nextConfig = {
  typedRoutes: true,
  turbopack: {
    root: path.resolve(process.cwd(), "../..")
  }
};

export default withJunior(nextConfig, { sentry: true });
