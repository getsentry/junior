import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTEGRATION_ROOT = "packages/junior/tests/integration";
const INTERNAL_MOCK_PATTERN = /\bvi\.(?:doMock|mock)\(\s*["']@\//;

/** Report integration tests that replace Junior-owned modules. */
export function checkIntegrationInternalMocks(files) {
  const errors = [];

  for (const file of files) {
    if (INTERNAL_MOCK_PATTERN.test(file.contents)) {
      errors.push(
        `${file.path}: integration tests must not mock Junior-owned @/ modules`,
      );
    }
  }

  return errors;
}

function collectIntegrationTests(root) {
  const directory = path.join(root, INTEGRATION_ROOT);
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => {
      const absolutePath = path.join(entry.parentPath, entry.name);
      return {
        path: path.relative(root, absolutePath).split(path.sep).join("/"),
        contents: fs.readFileSync(absolutePath, "utf8"),
      };
    });
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDirectory, "..");
  const errors = checkIntegrationInternalMocks(collectIntegrationTests(root));
  if (errors.length === 0) {
    console.log("Integration tests do not mock Junior wiring.");
    return;
  }
  console.error(["Test architecture check failed:", ...errors].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
