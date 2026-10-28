import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServerEventsProvider } from "@/components/server-events";
import { LocaleProvider } from "@/components/locale-provider";

// tsx compiles with the app tsconfig (jsx: "preserve" -> classic runtime); components that omit
// `import React` need the global at render time.
(globalThis as { React?: typeof React }).React = React;

/** Static render with the providers components expect (effects never run, so no fetches happen). */
export function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<ServerEventsProvider><LocaleProvider>{node}</LocaleProvider></ServerEventsProvider>);
}
