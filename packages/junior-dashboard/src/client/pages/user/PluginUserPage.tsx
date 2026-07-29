import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Boxes, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router";
import {
  pluginUserPageContentSchema,
  type PluginUserPageContent,
  type PluginUserPageLink,
} from "@sentry/junior-plugin-api";

import { Button } from "../../components/Button";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { deleteDashboardResource, fetchDashboardJson } from "../../http";
import { dashboardContainerClass } from "../../styles";

/** Build the dashboard route for a plugin-owned user page. */
export function pluginUserPagePath(pluginName: string, pageId: string): string {
  return `/settings/plugins/${encodeURIComponent(pluginName)}/${encodeURIComponent(pageId)}`;
}

/** Render a plugin-owned user page from its bounded list response. */
export function PluginUserPage(props: { pages: PluginUserPageLink[] }) {
  const { pageId, pluginName } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const page = props.pages.find(
    (item) => item.pluginName === pluginName && item.id === pageId,
  );
  const searchQuery = searchParams.get("q")?.trim() ?? "";
  const [searchText, setSearchText] = useState(searchQuery);
  useEffect(() => {
    setSearchText(searchQuery);
  }, [searchQuery]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const normalized = searchText.trim();
      if (normalized === searchQuery) return;
      setSearchParams(normalized ? { q: normalized } : {}, { replace: true });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchQuery, searchText, setSearchParams]);

  const queryKey = [
    "dashboard",
    "plugin-user-page",
    pluginName,
    pageId,
    searchQuery,
  ] as const;
  const query = useInfiniteQuery({
    enabled: Boolean(page),
    initialPageParam: undefined as string | undefined,
    queryKey,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (searchQuery) params.set("q", searchQuery);
      if (pageParam) params.set("cursor", pageParam);
      const search = params.toString();
      return fetchDashboardJson(
        pluginUserPageContentSchema,
        `/api/user-pages/${encodeURIComponent(pluginName!)}/${encodeURIComponent(pageId!)}${search ? `?${search}` : ""}`,
        signal,
      );
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    placeholderData: (previousData) => previousData,
    retry: false,
  });
  const records = useMemo(
    () => [
      ...new Map(
        (query.data?.pages ?? [])
          .flatMap((content) => content.records)
          .map((record) => [record.id, record]),
      ).values(),
    ],
    [query.data?.pages],
  );
  const content = query.data?.pages[0];
  const action = useMutation({
    mutationFn: async (
      recordAction: NonNullable<
        PluginUserPageContent["records"][number]["actions"]
      >[number],
    ) => {
      if (
        recordAction.confirmation &&
        !window.confirm(recordAction.confirmation)
      ) {
        return false;
      }
      await deleteDashboardResource(recordAction.href);
      return true;
    },
    onSuccess: async (changed) => {
      if (changed) {
        await queryClient.resetQueries({ queryKey });
      }
    },
  });

  if (!page) return <Navigate replace to="/" />;
  if (!query.data && !query.error) {
    return <LoadingView label={`Loading ${page.label}`} />;
  }

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto grid w-full max-w-3xl gap-6">
        <PageHeader
          description={page.description}
          eyebrow={page.pluginDisplayName}
          title={page.label}
        />
        {content?.searchPlaceholder ? (
          <label className="relative block">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dashboard-text-muted"
              size={15}
            />
            <span className="sr-only">{content.searchPlaceholder}</span>
            <input
              className="w-full rounded border border-white/15 bg-black py-2 pr-3 pl-9 text-sm text-dashboard-text placeholder:text-dashboard-text-muted focus:border-cyan-300/50 focus:outline-none"
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={content.searchPlaceholder}
              type="search"
              value={searchText}
            />
          </label>
        ) : null}
        {query.error ? (
          <Card padding="md">
            <p className="m-0 text-sm text-rose-300">
              Could not load {page.label.toLowerCase()}. Try again.
            </p>
          </Card>
        ) : records.length === 0 ? (
          <Card padding="md">
            <div className="flex items-center gap-4">
              <div className="grid size-10 shrink-0 place-items-center rounded border border-white/[0.07] bg-white/[0.025] text-dashboard-text-muted">
                <Boxes aria-hidden="true" size={17} />
              </div>
              <p className="m-0 text-sm text-dashboard-text-muted">
                {content?.emptyText ?? `No ${page.label.toLowerCase()}.`}
              </p>
            </div>
          </Card>
        ) : (
          <div className="grid gap-3">
            {records.map((record) => (
              <Card key={record.id} padding="md">
                <div className="flex items-start gap-3">
                  <h2 className="m-0 min-w-0 flex-1 font-display text-base font-medium text-dashboard-text">
                    {record.title}
                  </h2>
                  {record.actions?.map((recordAction) => (
                    <button
                      aria-label={`${recordAction.label}: ${record.title}`}
                      className={`cursor-pointer border-0 bg-transparent p-1 text-dashboard-text-muted transition-colors ${
                        recordAction.tone === "danger"
                          ? "hover:text-rose-300"
                          : "hover:text-dashboard-text"
                      }`}
                      disabled={
                        action.isPending &&
                        action.variables?.href === recordAction.href
                      }
                      key={`${recordAction.method}:${recordAction.href}`}
                      onClick={() => action.mutate(recordAction)}
                      title={recordAction.label}
                      type="button"
                    >
                      {recordAction.tone === "danger" ? (
                        <Trash2 aria-hidden="true" size={16} />
                      ) : (
                        recordAction.label
                      )}
                    </button>
                  ))}
                </div>
                {record.description ? (
                  <p className="mt-2 mb-0 text-sm text-dashboard-text-muted">
                    {record.description}
                  </p>
                ) : null}
                {record.metadata?.length ? (
                  <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
                    {record.metadata.map((item) => (
                      <div key={item.label}>
                        <dt className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-dashboard-text-muted">
                          {item.label}
                        </dt>
                        <dd className="mt-1 ml-0 font-mono text-[0.68rem] text-dashboard-text-muted">
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </Card>
            ))}
            {!query.isPlaceholderData && query.hasNextPage ? (
              <Button
                className="justify-self-center"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : null}
            {action.error ? (
              <p className="m-0 text-center text-sm text-rose-300">
                Could not complete this action. Try again.
              </p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
