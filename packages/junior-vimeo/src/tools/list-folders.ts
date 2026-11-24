import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  FOLDER_FIELDS,
  folderListSchema,
  PAGE_SIZE,
  parseFolder,
  VIMEO_OPERATIONS,
  vimeoClient,
} from "../tool-support/vimeo-api.js";

const ownerIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,20}$/, "Use the numeric Vimeo user ID of the team owner")
  .describe(
    "Numeric user ID of a Vimeo team owner, the number after vimeo.com/user/ in a team folder link. Lists the team folders that the account can reach. Omit to list the account's own folders.",
  );

/** List the Vimeo folders that the connected account can reach. */
export const vimeoListFoldersTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "List the Vimeo folders that the connected account can reach, by name, 100 per page, with each folder's URI, name, owner, and vimeo.com link. Lists the account's own folders, or the folders of a Vimeo team that the account is on.",
  inputSchema: z
    .object({
      team_owner_id: ownerIdSchema.optional(),
      page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(1)
        .describe("Page number. Default 1."),
    })
    .strict(),
  outputSchema: pluginToolOutputSchema.extend({
    folders: z
      .array(
        z.object({
          folder_uri: z.string(),
          name: z.string().optional(),
          owner_id: z.string(),
          owner_name: z.string().optional(),
          link: z.string().optional(),
        }),
      )
      .max(PAGE_SIZE),
    next_page: z.number().optional(),
  }),
  async execute(input, options, ctx) {
    const client = vimeoClient(
      ctx.egress,
      VIMEO_OPERATIONS.listFolders,
      options.signal,
    );
    // A team member reaches team folders under the team owner's user.
    const owner = input.team_owner_id ? `/users/${input.team_owner_id}` : "/me";
    const result = folderListSchema.parse(
      await client.api(
        "GET",
        `${owner}/projects?fields=${FOLDER_FIELDS}&per_page=${PAGE_SIZE}&page=${input.page}&sort=name&direction=asc`,
      ),
    );
    return {
      folders: result.data.map((folder) => {
        // The list schema accepts only folder URIs.
        const { owner, uri } = parseFolder(folder.uri)!;
        return {
          folder_uri: uri,
          name: folder.name ?? undefined,
          owner_id: owner,
          owner_name: folder.user?.name ?? undefined,
          link: folder.manage_link ?? folder.link ?? undefined,
        };
      }),
      next_page: result.paging?.next ? input.page + 1 : undefined,
    };
  },
});
