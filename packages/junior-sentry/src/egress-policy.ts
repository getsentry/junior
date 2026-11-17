/**
 * Sentry egress policy.
 *
 * Junior never deletes a Sentry organization, project, or user, whatever
 * the credential, grant, or Actor role. Deletion is irreversible for the
 * people who own the data, so a person does it in Sentry.
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

// `DELETE /api/0/organizations/{org}/`,
// `DELETE /api/0/projects/{org}/{project}/`, and
// `DELETE /api/0/users/{user}/`.
function isProtectedDeletion(request: EgressHookContext["request"]): boolean {
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
    (resource === "projects" && rest.length === 2) ||
    (resource === "users" && rest.length === 1)
  );
}

/** Deny Sentry organization, project, and user deletion from the Sandbox. */
export function enforceSentryEgressPolicy(
  request: EgressHookContext["request"],
): void {
  if (isProtectedDeletion(request)) {
    throw new EgressPolicyDenied(
      "Deleting a Sentry organization, project, or user is blocked here. A person must do this in Sentry. This is a runtime policy, not a Sentry permission failure; do not ask for more Sentry permissions.",
    );
  }
}
