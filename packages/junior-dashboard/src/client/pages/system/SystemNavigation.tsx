import { Boxes, ChevronDown, Gauge } from "lucide-react";
import { NavLink, useLocation, useNavigate } from "react-router";

import { cn, dashboardInteractiveTextClass } from "../../styles";
import {
  normalizeSystemPath,
  systemPluginPath,
  systemPluginsPath,
  type SystemPlugin,
} from "./SystemPlugins";

/** Render route-backed navigation for the System overview and loaded plugins. */
export function SystemNavigation(props: {
  plugins: SystemPlugin[];
  reportingPlugins: SystemPlugin[];
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPlugin = findSystemPlugin(location.pathname, props.plugins);
  const currentPluginHasReporting = props.reportingPlugins.some(
    (plugin) => plugin.name === currentPlugin?.name,
  );
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex min-w-fit items-center gap-2.5 rounded-md border px-3 py-2 font-display text-sm font-medium no-underline transition-colors lg:min-w-0",
      isActive
        ? "border-cyan-300/20 bg-cyan-300/[0.08] text-cyan-100"
        : cn(
            "border-transparent hover:border-white/[0.07] hover:bg-white/[0.03]",
            dashboardInteractiveTextClass,
          ),
    );

  return (
    <>
      <label className="grid gap-1.5 lg:hidden">
        <span className="font-mono text-[0.58rem] font-medium uppercase tracking-[0.16em] text-dashboard-text-muted">
          System view
        </span>
        <span className="relative">
          <select
            aria-label="System view"
            className="w-full appearance-none rounded-md border border-white/[0.09] bg-[#0a0a0d] py-2.5 pr-10 pl-3 font-display text-sm font-medium text-dashboard-text outline-none focus:border-cyan-300/30"
            onChange={(event) => navigate(event.target.value)}
            value={systemNavigationValue(location.pathname, props.plugins)}
          >
            <option value="/system">Overview</option>
            <option value={systemPluginsPath}>All Plugins</option>
            {props.reportingPlugins.map((plugin) => (
              <option key={plugin.name} value={systemPluginPath(plugin.name)}>
                {plugin.displayName}
              </option>
            ))}
            {currentPlugin && !currentPluginHasReporting ? (
              <option disabled value={systemPluginPath(currentPlugin.name)}>
                {currentPlugin.displayName}
              </option>
            ) : null}
          </select>
          <ChevronDown
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-dashboard-text-muted"
            size={15}
          />
        </span>
      </label>
      <aside
        aria-label="System navigation"
        className="sticky top-24 hidden min-w-0 border-r border-white/[0.06] pr-4 lg:block"
      >
        <nav className="grid min-w-0 gap-1">
          <NavLink className={linkClass} end to="/system">
            <Gauge aria-hidden="true" size={15} strokeWidth={1.8} />
            Overview
          </NavLink>
          <div className="px-3 pt-4 pb-1.5 font-mono text-[0.56rem] font-medium uppercase tracking-[0.16em] text-dashboard-text-muted">
            Plugins
          </div>
          <NavLink className={linkClass} end to={systemPluginsPath}>
            <Boxes aria-hidden="true" size={15} strokeWidth={1.8} />
            All Plugins
          </NavLink>
          {props.reportingPlugins.length ? (
            <div className="mt-3 grid min-w-0 gap-1">
              {props.reportingPlugins.map((plugin) => (
                <NavLink
                  className={linkClass}
                  key={plugin.name}
                  to={systemPluginPath(plugin.name)}
                >
                  <Boxes aria-hidden="true" size={15} strokeWidth={1.8} />
                  <span className="truncate">{plugin.displayName}</span>
                </NavLink>
              ))}
            </div>
          ) : null}
        </nav>
      </aside>
    </>
  );
}

function systemNavigationValue(
  pathname: string,
  plugins: SystemPlugin[],
): string {
  const plugin = findSystemPlugin(pathname, plugins);
  if (plugin) return systemPluginPath(plugin.name);
  return normalizeSystemPath(pathname) === systemPluginsPath
    ? systemPluginsPath
    : "/system";
}

function findSystemPlugin(
  pathname: string,
  plugins: SystemPlugin[],
): SystemPlugin | undefined {
  const normalizedPath = normalizeSystemPath(pathname);
  return plugins.find(
    (candidate) => systemPluginPath(candidate.name) === normalizedPath,
  );
}
