import path from "node:path";
import { withJunior } from "junior/config";

const rootDir = path.resolve(import.meta.dirname, "../..");

export default withJunior({
  turbopack: {
    root: rootDir
  }
});
