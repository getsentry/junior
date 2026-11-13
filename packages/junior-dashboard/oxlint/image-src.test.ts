import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noRawExternalImageSrcRule } from "./image-src.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const externalSrc = [{ messageId: "externalSrc" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
}).run("no-raw-external-image-src", noRawExternalImageSrcRule, {
  valid: [
    // A path from the API, such as an avatar or image route path.
    `const Photo = () => <img alt="" src={actor.avatarUrl} />;`,
    `const Logo = () => <img alt="" src="/junior-logo.svg" />;`,
    "const Thumb = () => <AvatarImage src={`/api/images/${id}?w=128`} />;",
    // Links are not images.
    `const Link = () => <a href="https://example.com/photo.png">Photo</a>;`,
  ],
  invalid: [
    {
      code: `const A = () => <img alt="" src="https://example.com/photo.png" />;`,
      errors: externalSrc,
    },
    {
      code: `const A = () => <img alt="" src={"//cdn.example.com/photo.png"} />;`,
      errors: externalSrc,
    },
    {
      code: "const A = () => <AvatarImage src={`https://avatars.example.com/${id}.png`} />;",
      errors: externalSrc,
    },
    {
      code: `const A = () => <AvatarPrimitive.Image src="http://example.com/a.png" />;`,
      errors: externalSrc,
    },
    {
      code: `const A = () => <img alt="" srcSet="https://example.com/a.png 2x" />;`,
      errors: externalSrc,
    },
  ],
});
