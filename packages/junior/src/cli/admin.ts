/**
 * Operator CLI for the Junior-wide admin role.
 *
 * Admin changes happen only here, out of band. The dashboard and Slack can
 * read the role but cannot change it, so no one can make themselves admin.
 */
import type { JuniorDatabase } from "@/db/db";
import {
  listAdminUsersFromSql,
  setUserAdminFromSql,
} from "@/chat/plugins/viewer";

export const ADMIN_USAGE =
  "usage: junior admin list\n       junior admin grant <email>\n       junior admin revoke <email>";

interface AdminCliIo {
  error: (line: string) => void;
  log: (line: string) => void;
}

const DEFAULT_IO: AdminCliIo = {
  error: console.error,
  log: console.log,
};

async function defaultDb(): Promise<JuniorDatabase> {
  const { getDb } = await import("@/chat/db");
  return getDb();
}

/** Run `junior admin` and return a process exit code. */
export async function runAdmin(
  argv: string[],
  options: { db?: JuniorDatabase; io?: AdminCliIo } = {},
): Promise<number> {
  const io = options.io ?? DEFAULT_IO;
  const [subcommand, email, ...rest] = argv;
  if (rest.length > 0) {
    io.error(ADMIN_USAGE);
    return 1;
  }

  if (subcommand === "list" && email === undefined) {
    const admins = await listAdminUsersFromSql(
      options.db ?? (await defaultDb()),
    );
    if (admins.length === 0) {
      io.log("No Junior admins.");
    }
    for (const admin of admins) {
      io.log(admin.email);
    }
    return 0;
  }

  if ((subcommand === "grant" || subcommand === "revoke") && email?.trim()) {
    const isAdmin = subcommand === "grant";
    const user = await setUserAdminFromSql(
      options.db ?? (await defaultDb()),
      email,
      isAdmin,
    );
    if (!user) {
      io.error(
        isAdmin
          ? `Could not grant admin: "${email}" is not a valid email.`
          : `No Junior user has the email "${email}".`,
      );
      return 1;
    }
    io.log(
      isAdmin
        ? `${user.email} is now a Junior admin.`
        : `${user.email} is no longer a Junior admin.`,
    );
    return 0;
  }

  io.error(ADMIN_USAGE);
  return 1;
}
