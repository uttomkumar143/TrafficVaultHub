import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { routes } from "@/routes";

/**
 * Render smoke test.
 * Mounts the real route table (AppShell + HomePage) under a MemoryRouter and a
 * fresh QueryClient. The backend health probe is stubbed so the test needs no
 * running Worker and reports no fabricated data.
 */
function renderApp(initialPath = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the application shell and home page", async () => {
    renderApp("/");

    // AppShell landmarks
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();

    // HomePage content
    expect(
      screen.getByRole("heading", { level: 1, name: "TrafficVaultHub" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-check" })).toBeInTheDocument();

    // Health probe result surfaces from the (stubbed) API call
    expect(
      await screen.findByText("Backend responded: status = ok"),
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("renders the not-found page for unknown routes", () => {
    renderApp("/this-route-does-not-exist");

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return home" })).toHaveAttribute("href", "/");
  });
});
