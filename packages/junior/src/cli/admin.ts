/**
 * Operator CLI for the Junior-wide admin role.
 *
 * Admin changes happen only here, out of band. The dashboard and Slack can
 * read the role but cannot change it, so no one can make themselves admin.
 */
import { getDb } from "@/chat/db";
import {
  listAdminUsersFromSql,
  setUserAdminFromSql,
} from "@/chat/plugins/viewer";
import { CLI_USAGE } from "./run";

/** Run `junior admin list`, `grant <email>`, or `revoke <email>`. */
export async function runAdmin(argv: string[]): Promise<number> {
  const [subcommand, email, ...rest] = argv;

  if (subcommand === "list" && email === undefined) {
    const admins = await listAdminUsersFromSql(getDb());
    if (admins.length === 0) console.log("No Junior admins.");
    for (const admin of admins) console.log(admin.email);
    return 0;
  }

  if (
    (subcommand === "grant" || subcommand === "revoke") &&
    email?.trim() &&
    rest.length === 0
  ) {
    const isAdmin = subcommand === "grant";
    const user = await setUserAdminFromSql(getDb(), email, isAdmin);
    if (!user) {
      console.error(
        isAdmin
          ? `Could not grant admin: "${email}" is not a valid email.`
          : `No Junior user has the email "${email}".`,
      );
      return 1;
    }
    console.log(
      isAdmin
        ? `${user.email} is now a Junior admin.`
        : `${user.email} is no longer a Junior admin.`,
    );
    return 0;
  }

  console.error(CLI_USAGE);
  return 1;
}
