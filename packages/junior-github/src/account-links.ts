import type {
  ObjectAnnotation,
  PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";

// Enterprise Managed User logins have an underscore, such as `ada_acme`.
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;

// Top-level github.com pages that are not accounts.
const NON_ACCOUNT_PATHS = new Set([
  "about",
  "apps",
  "codespaces",
  "collections",
  "contact",
  "copilot",
  "dashboard",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "logout",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "signup",
  "sponsors",
  "stars",
  "topics",
  "trending",
]);

function githubAccountCard(login: string): ObjectAnnotation {
  return {
    kind: "object",
    objectType: "person",
    key: `github:${login.toLowerCase()}`,
    label: `@${login}`,
    title: login,
    url: `https://github.com/${login}`,
    displayType: "GitHub account",
    facts: { type: "person", githubHandle: login },
  };
}

/**
 * GitHub profile links, such as `https://github.com/octocat`. A login that
 * links to a known person shows their Junior person card. Any other login
 * shows a GitHub account card. Both come from the link alone, so the card
 * needs no GitHub request.
 */
export const githubAccountLinks: PluginObjectLinkDefinition = {
  filters: [{ host: "github.com", pathPattern: "/*" }],
  // A GitHub profile is public, and the card holds only the login.
  canView: async () => true,
  objectType: "person",
  async resolve(ctx, url) {
    const login = url.pathname.split("/")[1] ?? "";
    if (
      !GITHUB_LOGIN_PATTERN.test(login) ||
      NON_ACCOUNT_PATHS.has(login.toLowerCase())
    ) {
      return undefined;
    }
    return (
      (await ctx.findPerson({ provider: "github", handle: login })) ??
      githubAccountCard(login)
    );
  },
};
