const SENTRY_HOSTS = new Set(["sentry.io", "us.sentry.io", "de.sentry.io"]);

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function text(value: string, init?: ResponseInit): Response {
  return new Response(value, {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function hasBearerAuth(request: Request): boolean {
  return (request.headers.get("authorization") ?? "").startsWith("Bearer ");
}

function organizationPayload(): Record<string, unknown> {
  return {
    id: "1",
    slug: "getsentry",
    name: "Sentry",
    dateCreated: "2026-01-01T00:00:00Z",
    status: { id: "active", name: "active" },
    avatar: {
      avatarType: "letter_avatar",
      avatarUuid: null,
      avatarUrl: null,
    },
    features: [],
    isEarlyAdopter: false,
    require2FA: false,
    links: {
      organizationUrl: "https://sentry.io/organizations/getsentry/",
      regionUrl: "https://us.sentry.io",
    },
    access: [],
    role: "member",
  };
}

function projectPayload(): Record<string, unknown> {
  return {
    id: "1",
    slug: "junior",
    name: "junior",
    platform: "javascript",
    dateCreated: "2026-01-01T00:00:00Z",
    isBookmarked: false,
    isMember: true,
    features: [],
    firstEvent: "2026-05-27T00:00:00Z",
    firstTransactionEvent: false,
    hasSessions: false,
    hasProfiles: false,
    organization: { slug: "getsentry", name: "Sentry" },
    team: {
      id: "1",
      slug: "junior",
      name: "junior",
    },
    teams: [
      {
        id: "1",
        slug: "junior",
        name: "junior",
      },
    ],
  };
}

function issuePayload(): Record<string, unknown> {
  return {
    id: "100",
    shortId: "JUNIOR-1",
    title: "Eval issue",
    culprit: "eval fixture",
    permalink: "https://sentry.io/organizations/getsentry/issues/100/",
    issueType: "error",
    metadata: {
      type: "Error",
      value: "Eval issue",
    },
    status: "unresolved",
    level: "error",
    count: "1",
    userCount: 1,
    firstSeen: "2026-05-27T00:00:00Z",
    lastSeen: "2026-05-27T00:00:00Z",
    project: {
      id: "1",
      slug: "junior",
      name: "junior",
    },
  };
}

/** Intercept Sentry API traffic for test scenarios without sandbox credentials. */
export async function interceptTestSentryHttp(input: {
  provider: string;
  request: Request;
  upstreamUrl: URL;
}): Promise<Response | undefined> {
  if (
    input.provider !== "sentry" ||
    !SENTRY_HOSTS.has(input.upstreamUrl.hostname)
  ) {
    return undefined;
  }

  if (!hasBearerAuth(input.request)) {
    return text("missing authorization\n", { status: 401 });
  }

  if (
    input.request.method === "GET" &&
    input.upstreamUrl.pathname === "/api/0/organizations/"
  ) {
    return json([organizationPayload()]);
  }

  if (
    input.request.method === "GET" &&
    input.upstreamUrl.pathname === "/api/0/organizations/getsentry/"
  ) {
    return json(organizationPayload());
  }

  if (
    input.request.method === "GET" &&
    (input.upstreamUrl.pathname === "/api/0/projects/" ||
      input.upstreamUrl.pathname === "/api/0/organizations/getsentry/projects/")
  ) {
    return json([projectPayload()]);
  }

  if (
    input.request.method === "GET" &&
    input.upstreamUrl.pathname === "/api/0/organizations/getsentry/issues/"
  ) {
    return json([issuePayload()]);
  }

  return text(
    `Missing eval Sentry HTTP fixture for ${input.request.method} ${input.upstreamUrl.pathname}\n`,
    { status: 501 },
  );
}
