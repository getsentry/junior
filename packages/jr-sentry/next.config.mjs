import { withJunior } from "junior/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default withJunior({
  turbopack: {
    root: path.resolve(__dirname, "../..")
  }
});
