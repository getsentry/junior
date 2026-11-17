/**
 * Sentry egress policy.
 *
 * Junior never deletes a Sentry organization or project, whatever the
 * credential, grant, or Actor role. Deletion is irreversible for the people
 * who own the data, so a person does it in Sentry.
 */
import { EgressPolicyDenied } from "@sentry/junior-plugin-api";
import type { EgressHookContext } from "@sentry/junior-plugin-api";

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

// `DELETE /api/0/organizations/{org}/` and
// `DELETE /api/0/projects/{org}/{project}/`.
function isOrganizationOrProjectDeletion(
  request: EgressHookContext["request"],
): boolean {
  if (request.method.toUpperCase() !== "DELETE") {
    return false;
  }
  const [api, version, resource, ...rest] = apiPathSegments(
    new URL(request.url),
  );
  if (api !== "api" || version !== "0") {
    return false;
  }
  return (
    (resource === "organizations" && rest.length === 1) ||
    (resource === "projects" && rest.length === 2)
  );
}

/** Deny Sentry organization and project deletion from the Sandbox. */
export function enforceSentryEgressPolicy(
  request: EgressHookContext["request"],
): void {
  if (isOrganizationOrProjectDeletion(request)) {
    throw new EgressPolicyDenied(
      "Junior does not delete Sentry organizations or projects. A person must do this in Sentry. This is a Junior policy, not a Sentry permission failure; do not ask for more Sentry permissions.",
    );
  }
}
