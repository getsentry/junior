// Entry of the new dashboard UI, for users who turned on `experimentalUi`.
import { startDashboard } from "./client";
import { InboxShell } from "./client/shell/InboxShell";

startDashboard(InboxShell, "inbox");
