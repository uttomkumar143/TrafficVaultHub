import { createBrowserRouter } from "react-router";
import { AppShell } from "@/components/layout/app-shell";
import { HomePage } from "@/routes/home/home-page";
import { NotFoundPage } from "@/routes/not-found-page";

/** Route table. Additional feature routes are registered here in later phases. */
export const routes = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
