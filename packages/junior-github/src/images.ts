/**
 * Description images of GitHub objects, served through the Junior image
 * route. Each read checks that the viewer's linked GitHub account can see
 * the repository. Only then does Junior fetch the image with the App.
 */
import {
  decodeObjectImageRef,
  type ImageFetch,
  type PluginImageSource,
} from "@sentry/junior-plugin-api";
import { githubImageKind } from "./object-facts.js";
import { viewerCanSeeRepository } from "./repository-access.js";
import { githubAttachmentLocation } from "./tool-support/github-api.js";

// Annotation keys of pull requests and issues: `owner/repo#number`.
const OBJECT_KEY = /^([\w.-]+)\/([\w.-]+)#\d+$/;

/** Serve the description images of GitHub objects to viewers who can see the repository. */
export const githubImageSource: PluginImageSource = {
  async resolve(ctx, ref): Promise<ImageFetch | undefined> {
    const image = decodeObjectImageRef(ref);
    const key = image && OBJECT_KEY.exec(image.key);
    if (!image || !key || !URL.canParse(image.url)) return undefined;
    const kind = githubImageKind(new URL(image.url));
    if (!kind) return undefined;
    const repository = { name: key[2]!, owner: key[1]! };
    if (!(await viewerCanSeeRepository(ctx, repository))) return undefined;
    return kind === "artifact"
      ? { url: image.url }
      : {
          url: image.url,
          location: () => githubAttachmentLocation(ctx.egress, image.url),
        };
  },
};
