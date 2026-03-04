// src/app/layout.tsx
import { jsx } from "react/jsx-runtime";
function RootLayout({ children }) {
  return /* @__PURE__ */ jsx("html", { lang: "en", children: /* @__PURE__ */ jsx("body", { children }) });
}
export {
  RootLayout as default
};
