/**
 * Sentry egress policy.
 *
 * Junior never deletes a Sentry organization, project, or user, whatever
 * the credential, grant, or Actor role. Deletion is irreversible for the
 * people who own the data, so a person does it in Sentry.
 *
 * Writes that use the Actor's account must be known writes: project, team,
 * alert, monitor, dashboard, and issue changes. Release, sourcemap, and debug
 * file writes, and every other write, are denied, because Sandbox code is
 * untrusted. A request that carries its own credential is not limited by the
 * known writes.
 */
import { EgressPolicyDenied } from "@sentry/junior-plugin-api";
import type { EgressHookContext } from "@sentry/junior-plugin-api";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const NOT_A_PERMISSION_FAILURE =
  "This is a runtime policy, not a Sentry permission failure; do not ask for more Sentry permissions.";

// Path patterns after `/api/0/`. `*` matches one segment, and `a|b` matches
// either name. Sentry routes issues under the organization and at the top
// level, and `groups` and `comments` are aliases of `issues` and `notes`.
const KNOWN_WRITES: ReadonlyArray<{ methods: string[]; path: string }> = [
  // Projects and teams.
  { methods: ["POST"], path: "teams/*/*/projects" },
  { methods: ["POST"], path: "organizations/*/projects" },
  { methods: ["PUT"], path: "projects/*/*" },
  { methods: ["POST", "DELETE"], path: "projects/*/*/teams/*" },
  { methods: ["POST"], path: "organizations/*/teams" },
  { methods: ["PUT"], path: "teams/*/*" },
  { methods: ["POST"], path: "organizations/*/members/*/teams/*" },
  // Alerts and monitors.
  { methods: ["POST"], path: "organizations/*/alert-rules" },
  { methods: ["PUT", "DELETE"], path: "organizations/*/alert-rules/*" },
  { methods: ["POST"], path: "projects/*/*/rules" },
  { methods: ["PUT", "DELETE"], path: "projects/*/*/rules/*" },
  { methods: ["POST"], path: "organizations/*/detectors" },
  { methods: ["PUT", "DELETE"], path: "organizations/*/detectors/*" },
  { methods: ["POST"], path: "organizations/*/workflows" },
  { methods: ["PUT", "DELETE"], path: "organizations/*/workflows/*" },
  { methods: ["POST"], path: "organizations/*/monitors" },
  { methods: ["PUT", "DELETE"], path: "organizations/*/monitors/*" },
  // Dashboards.
  { methods: ["POST"], path: "organizations/*/dashboards" },
  { methods: ["PUT", "DELETE"], path: "organizations/*/dashboards/*" },
  {
    methods: ["POST"],
    path: "organizations/*/dashboards/*/revisions/*/restore",
  },
  // Issue triage and investigation.
  { methods: ["PUT"], path: "organizations/*/issues|groups" },
  { methods: ["PUT"], path: "organizations/*/issues|groups/*" },
  { methods: ["PUT"], path: "issues|groups/*" },
  { methods: ["PUT"], path: "projects/*/*/issues|groups" },
  {
    methods: ["POST"],
    path: "organizations/*/issues|groups/*/notes|comments",
  },
  { methods: ["POST"], path: "issues|groups/*/notes|comments" },
  { methods: ["POST"], path: "organizations/*/issues|groups/*/autofix" },
  { methods: ["POST"], path: "issues|groups/*/autofix" },
  { methods: ["POST"], path: "organizations/*/issues|groups/*/summarize" },
  { methods: ["POST"], path: "issues|groups/*/summarize" },
  { methods: ["POST"], path: "organizations/*/search-agent/start" },
];

// Segments that name release, sourcemap, and debug file writes.
const UPLOAD_SEGMENTS = new Set([
  "artifactbundle",
  "chunk-upload",
  "difs",
  "dsyms",
  "files",
  "preprodartifacts",
  "releases",
]);

// Django decodes the path before routing, so match on the decoded segments.
function apiPathSegments(url: URL): string[] {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  return pathname.split("/").filter(Boolean);
}

// `DELETE /api/0/organizations/{org}/`,
// `DELETE /api/0/projects/{org}/{project}/`, and
// `DELETE /api/0/users/{user}/`.
function isProtectedDeletion(method: string, segments: string[]): boolean {
  if (method !== "DELETE") {
    return false;
  }
  const [api, version, resource, ...rest] = segments;
  if (api !== "api" || version !== "0") {
    return false;
  }
  return (
    (resource === "organizations" && rest.length === 1) ||
    (resource === "projects" && rest.length === 2) ||
    (resource === "users" && rest.length === 1)
  );
}

function matchesPath(segments: string[], pattern: string): boolean {
  const parts = pattern.split("/");
  return (
    parts.length === segments.length &&
    parts.every(
      (part, index) =>
        part === "*" || part.split("|").includes(segments[index] ?? ""),
    )
  );
}

function isKnownWrite(method: string, segments: string[]): boolean {
  const [api, version, ...rest] = segments;
  if (api !== "api" || version !== "0") {
    return false;
  }
  return KNOWN_WRITES.some(
    (write) => write.methods.includes(method) && matchesPath(rest, write.path),
  );
}

/**
 * Deny Sentry requests that the plugin does not allow from the Sandbox.
 *
 * Protected deletions are denied for any credential. Other writes are checked
 * only when Junior would add the Actor's credential.
 */
export function enforceSentryEgressPolicy(
  request: EgressHookContext["request"],
): void {
  const method = request.method.toUpperCase();
  const segments = apiPathSegments(new URL(request.url));
  if (isProtectedDeletion(method, segments)) {
    throw new EgressPolicyDenied(
      `Deleting a Sentry organization, project, or user is blocked here. A person must do this in Sentry. ${NOT_A_PERMISSION_FAILURE}`,
    );
  }
  if (
    request.withoutCredential ||
    READ_METHODS.has(method) ||
    isKnownWrite(method, segments)
  ) {
    return;
  }
  if (segments.some((segment) => UPLOAD_SEGMENTS.has(segment))) {
    throw new EgressPolicyDenied(
      `Creating Sentry releases or uploading sourcemaps or debug files with the requester's account is blocked here. Run this in CI with a Sentry auth token. ${NOT_A_PERMISSION_FAILURE}`,
    );
  }
  throw new EgressPolicyDenied(
    `This Sentry write is blocked here because it would use the requester's account. Allowed writes change projects, teams, alerts, monitors, dashboards, and issues. ${NOT_A_PERMISSION_FAILURE}`,
  );
}
