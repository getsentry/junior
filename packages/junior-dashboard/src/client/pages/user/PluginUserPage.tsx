import { Boxes, Trash2 } from "lucide-react";
import { Navigate, useLocation, useParams } from "react-router";
import type { PluginUserPageLink } from "@sentry/junior-plugin-api";

import { LoadingView } from "../../components/LoadingView";
import { LoadMorePagination } from "../../components/Pagination";
import { SearchInput } from "../../components/SearchInput";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { MemoryPage } from "../memory/MemoryPage";
import { pathWithSearch } from "../../searchParams";
import { dashboardContainerClass } from "../../styles";
import { usePluginUserPageData } from "./pluginUserPageData";

/** Build the canonical dashboard path for a plugin-owned page. */
export function pluginUserPagePath(pluginName: string, pageId: string): string {
  if (pluginName === "memory" && pageId === "memories") return "/memories";
  return `/plugins/${encodeURIComponent(pluginName)}/${encodeURIComponent(pageId)}`;
}

/** Render the memory library for its first-class permalink route. */
export function MemoryPermalinkRoute(props: { pages: PluginUserPageLink[] }) {
  const page = props.pages.find(
    (item) => item.pluginName === "memory" && item.id === "memories",
  );
  return page ? <MemoryPage page={page} /> : <Navigate replace to="/" />;
}

/** Select the core renderer for one registered plugin page. */
export function PluginUserPageRoute(props: { pages: PluginUserPageLink[] }) {
  const location = useLocation();
  const { "*": restPath, pageId, pluginName } = useParams();
  const page = props.pages.find(
    (item) => item.pluginName === pluginName && item.id === pageId,
  );
  if (!page) return <Navigate replace to="/" />;

  /**
   * Memory temporarily uses a first-class dashboard renderer because its
   * inspection UI exceeds the generic plugin page contract. The memory plugin
   * still owns data, authorization, and actions.
   *
   * Replace this special case when Junior has a proven custom plugin UI
   * contract.
   */
  if (page.pluginName === "memory" && page.id === "memories") {
    const suffix = restPath ? `/${restPath}` : "";
    return (
      <Navigate
        replace
        to={pathWithSearch(`/memories${suffix}`, location.search)}
      />
    );
  }

  return <PluginUserPage page={page} />;
}

/** Render a plugin-owned page with the bounded generic list UI. */
export function PluginUserPage(props: { page: PluginUserPageLink }) {
  const {
    action,
    content,
    query,
    records,
    runAction,
    searchText,
    setSearchText,
  } = usePluginUserPageData(props.page);

  if (!query.data && !query.error) {
    return <LoadingView label={`Loading ${props.page.label}`} />;
  }

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto grid w-full max-w-3xl gap-6">
        <PageHeader
          description={props.page.description}
          title={props.page.label}
        />
        {content?.metrics?.length ? (
          <section
            aria-label={`${props.page.label} overview`}
            className="grid gap-3 sm:grid-cols-2"
          >
            {content.metrics.map((metric) => (
              <Card className="p-4" key={metric.label}>
                <div className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
                  {metric.label}
                </div>
                <div className="mt-3 font-display text-2xl font-light text-dashboard-text">
                  {metric.value}
                </div>
                {metric.detail ? (
                  <div className="mt-1 font-mono text-xs text-dashboard-text-muted">
                    {metric.detail}
                  </div>
                ) : null}
              </Card>
            ))}
          </section>
        ) : null}
        {content?.searchPlaceholder ? (
          <SearchInput
            className="w-full"
            label={content.searchPlaceholder}
            onChange={setSearchText}
            placeholder={content.searchPlaceholder}
            size="default"
            value={searchText}
          />
        ) : null}
        {query.error ? (
          <Card padding="md">
            <p className="m-0 text-sm text-rose-300">
              Could not load {props.page.label.toLowerCase()}. Try again.
            </p>
          </Card>
        ) : records.length === 0 ? (
          <Card padding="md">
            <div className="flex items-center gap-4">
              <div className="grid size-10 shrink-0 place-items-center rounded border border-dashboard-border bg-dashboard-fill-soft text-dashboard-text-muted">
                <Boxes aria-hidden="true" size={17} />
              </div>
              <p className="m-0 text-sm text-dashboard-text-muted">
                {content?.emptyText ?? `No ${props.page.label.toLowerCase()}.`}
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
                      disabled={action.isPending}
                      key={`${recordAction.method}:${recordAction.href}`}
                      onClick={() => runAction(recordAction)}
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
                        <dt className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
                          {item.label}
                        </dt>
                        <dd className="mt-1 ml-0 font-mono text-xs text-dashboard-text-muted">
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </Card>
            ))}
            <LoadMorePagination
              hasMore={!query.isPlaceholderData && Boolean(query.hasNextPage)}
              loading={query.isFetchingNextPage}
              onLoadMore={() => void query.fetchNextPage()}
            />
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
