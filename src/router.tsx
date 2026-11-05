import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import { NotFoundPage } from "./components/public/NotFoundPage";

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    // Phase 5c: the same styled 404 as the root route, so no route can fall back
    // to a bare "<p>Not found</p>".
    defaultNotFoundComponent: () => <NotFoundPage />,
  });
}
