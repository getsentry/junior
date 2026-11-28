/**
 * Operator CLI for the Junior-wide admin role.
 *
 * Admin changes happen only here, out of band. The dashboard and Slack can
 * read the role but cannot change it, so no one can make themselves admin.
 */
import { withCliAppContext } from "./context";
import {
  listAdminUsersFromSql,
  setUserAdminFromSql,
} from "@/chat/plugins/viewer";
import type { JuniorDatabase } from "@/db/db";
import { CLI_USAGE } from "./run";

/** Run `junior admin list`, `grant <email>`, or `revoke <email>`. */
export async function runAdmin(argv: string[]): Promise<number> {
  return await withCliAppContext({}, async (context) =>
    runAdminCommand(context.sql.db(), argv),
  );
}

async function runAdminCommand(
  db: JuniorDatabase,
  argv: string[],
): Promise<number> {
  const [subcommand, email, ...rest] = argv;

  if (subcommand === "list" && email === undefined) {
    const admins = await listAdminUsersFromSql(db);
    if (admins.length === 0) console.log("No admins.");
    for (const admin of admins) console.log(admin.email);
    return 0;
  }

  if (
    (subcommand === "grant" || subcommand === "revoke") &&
    email?.trim() &&
    rest.length === 0
  ) {
    const isAdmin = subcommand === "grant";
    const user = await setUserAdminFromSql(db, email, isAdmin);
    if (!user) {
      console.error(
        isAdmin
          ? `Could not grant admin: "${email}" is not a valid email.`
          : `No User has the email "${email}".`,
      );
      return 1;
    }
    console.log(
      isAdmin
        ? `${user.email} is now an admin.`
        : `${user.email} is no longer an admin.`,
    );
    return 0;
  }

  console.error(CLI_USAGE);
  return 1;
}
