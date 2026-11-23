import { Navigate, useLocation, useParams } from "react-router";

import { automationPath } from "../format";

/** `/tasks` became `/automations`. */
export function LegacyAutomationsRedirect() {
  const location = useLocation();
  const suffix = location.pathname.slice("/tasks".length);
  return (
    <Navigate
      replace
      to={`/automations${suffix}${location.search}${location.hash}`}
    />
  );
}

/** The list became the Automations landing page. */
export function LegacyAutomationListRedirect() {
  const location = useLocation();
  return (
    <Navigate replace to={`/automations${location.search}${location.hash}`} />
  );
}

/** Execution history became the Runs tab of the Automation page. */
export function LegacyAutomationExecutionsRedirect() {
  const location = useLocation();
  const { automationId } = useParams();
  return (
    <Navigate
      replace
      to={`${automationPath(automationId ?? "", "runs")}${location.search}${location.hash}`}
    />
  );
}

/** People and Locations moved under System. */
export function LegacySystemRedirect(props: {
  section: "locations" | "people";
}) {
  const location = useLocation();
  const legacyPrefix = `/${props.section}`;
  const suffix = location.pathname.slice(legacyPrefix.length);
  return (
    <Navigate
      replace
      to={`/system/${props.section}${suffix}${location.search}${location.hash}`}
    />
  );
}
