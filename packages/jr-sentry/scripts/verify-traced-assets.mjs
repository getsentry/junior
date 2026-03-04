import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const requiredServerFilesPath = path.join(projectRoot, ".next", "required-server-files.json");

if (!fs.existsSync(requiredServerFilesPath)) {
  throw new Error(`Missing required-server-files.json: ${requiredServerFilesPath}`);
}

const requiredServerFiles = JSON.parse(fs.readFileSync(requiredServerFilesPath, "utf8"));
const config = requiredServerFiles?.config ?? {};
const env = config.env ?? {};
const tracingIncludes = config.outputFileTracingIncludes ?? {};

const soul = typeof env.JUNIOR_SOUL === "string" ? env.JUNIOR_SOUL.trim() : "";
if (soul.length === 0) {
  throw new Error("Build config is missing env.JUNIOR_SOUL; SOUL.md will not be inlined.");
}

const expectedInclude = "./packages/jr-sentry/data/**/*";
const apiIncludes = Array.isArray(tracingIncludes["/api/**"]) ? tracingIncludes["/api/**"] : [];
const wellKnownIncludes = Array.isArray(tracingIncludes["/.well-known/**"]) ? tracingIncludes["/.well-known/**"] : [];
if (!apiIncludes.includes(expectedInclude) || !wellKnownIncludes.includes(expectedInclude)) {
  throw new Error(
    [
      `Build config is missing ${expectedInclude} in outputFileTracingIncludes`,
      "for /api/** and /.well-known/**."
    ].join(" ")
  );
}

console.log("Verified build config: JUNIOR_SOUL is inlined and trace includes are configured.");
