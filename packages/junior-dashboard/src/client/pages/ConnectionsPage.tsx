import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import type { z } from "zod";
import {
  connectionListSchema,
  disconnectConnectionResponseSchema,
  startConnectionResponseSchema,
  type connectionSchema,
} from "@sentry/junior/api/schema";
import { del, fetchDashboardJson, post } from "../http";
import { dashboardContainerClass } from "../styles";
import { getDashboardAgentName } from "../agentName";
import { useDocumentTitle } from "../documentTitle";
import { Button } from "../components/Button";
import { InlineError } from "../components/InlineError";
import { Card } from "../components/layout/Card";

type Connection = z.infer<typeof connectionSchema>;

const connectionsQueryKey = ["dashboard", "connections"] as const;

function connectionPath(provider: string): string {
  return `/api/connections/${encodeURIComponent(provider)}`;
}

/** Connect and disconnect the viewer's plugin accounts. */
export function ConnectionsPage() {
  useDocumentTitle("Connected accounts");
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery({
    queryKey: connectionsQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(connectionListSchema, "/api/connections", signal),
    // OAuth finishes in another tab. Refresh when the viewer returns.
    refetchOnWindowFocus: true,
    retry: false,
  });
  const connectMutation = useMutation({
    mutationFn: (input: { provider: string; popup: Window | null }) =>
      post(startConnectionResponseSchema, connectionPath(input.provider), {}),
    onSuccess: ({ authorizationUrl }, { popup }) => {
      if (popup && !popup.closed) {
        popup.opener = null;
        popup.location.href = authorizationUrl;
        return;
      }
      window.location.assign(authorizationUrl);
    },
    onError: (_error, { popup }) => {
      popup?.close();
    },
  });
  const disconnectMutation = useMutation({
    mutationFn: (connection: Connection) =>
      del(
        disconnectConnectionResponseSchema,
        connectionPath(connection.provider),
      ),
    onSuccess: (_result, connection) => {
      queryClient.setQueryData<{ connections: Connection[] }>(
        connectionsQueryKey,
        (current) =>
          current && {
            connections: current.connections.map((item) =>
              item.provider === connection.provider
                ? {
                    provider: item.provider,
                    displayName: item.displayName,
                    description: item.description,
                    connected: false,
                  }
                : item,
            ),
          },
      );
    },
  });
  const connections = connectionsQuery.data?.connections ?? [];
  const busy = connectMutation.isPending || disconnectMutation.isPending;
  const displayedError = connectMutation.isError
    ? "Could not start the connection. Try again."
    : disconnectMutation.isError
      ? "Could not disconnect the account. Try again."
      : !connectionsQuery.data && connectionsQuery.isError
        ? "Could not load connected accounts. Try again."
        : undefined;

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto w-full max-w-3xl">
        <h1 className="m-0 text-2xl font-bold">Connected accounts</h1>
        <p className="mt-2 mb-0 max-w-2xl text-sm text-dashboard-text-muted">
          Connect an account so {getDashboardAgentName()} can act as you in
          conversations you start here.
        </p>

        <Card className="mb-0 mt-6" padding="md" variant="raised">
          {displayedError ? (
            <InlineError className="mb-4">{displayedError}</InlineError>
          ) : null}
          <div className="space-y-2">
            {connectionsQuery.isPending ? (
              <p className="m-0 text-sm text-dashboard-text-muted">
                Loading connected accounts…
              </p>
            ) : connections.length === 0 && !connectionsQuery.isError ? (
              <p className="m-0 text-sm text-dashboard-text-muted">
                No installed plugins support account connections.
              </p>
            ) : (
              connections.map((connection) => (
                <div
                  className="flex items-center gap-3 rounded-md border border-dashboard-border-strong p-3"
                  key={connection.provider}
                >
                  <Plug className="shrink-0 text-dashboard-accent" size={16} />
                  <div className="min-w-0 flex-1">
                    <p className="m-0 truncate text-sm font-semibold">
                      {connection.displayName}
                    </p>
                    <p className="mt-1 mb-0 truncate text-xs text-dashboard-text-muted">
                      {connection.connected ? (
                        connection.account ? (
                          <>
                            Connected as{" "}
                            {connection.account.url ? (
                              <a
                                className="text-dashboard-text"
                                href={connection.account.url}
                                rel="noreferrer"
                                target="_blank"
                              >
                                {connection.account.label}
                              </a>
                            ) : (
                              connection.account.label
                            )}
                          </>
                        ) : (
                          "Connected"
                        )
                      ) : (
                        connection.description
                      )}
                    </p>
                  </div>
                  {connection.connected ? (
                    <Button
                      aria-label={`Disconnect ${connection.displayName}`}
                      disabled={busy}
                      onClick={() => {
                        connectMutation.reset();
                        disconnectMutation.mutate(connection);
                      }}
                      tone="danger"
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      aria-label={`Connect ${connection.displayName}`}
                      disabled={busy}
                      onClick={() => {
                        disconnectMutation.reset();
                        // Open the tab during the click so popup blockers
                        // allow it, then point it at the provider.
                        const popup = window.open("about:blank", "_blank");
                        connectMutation.mutate({
                          provider: connection.provider,
                          popup,
                        });
                      }}
                    >
                      Connect
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>
      </section>
    </div>
  );
}
