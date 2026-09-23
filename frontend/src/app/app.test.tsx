import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { routes } from "@/routes";
import { __resetSessionStoreForTests } from "@/lib/session-store";
import { renderWithProviders, stubFetch } from "@/test/utils";

/**
 * Render smoke test.
 * Mounts the real route table (AppShell + HomePage) under a MemoryRouter with
 * the real providers. The backend health probe is stubbed so the test needs
 * no running Worker and reports no fabricated data.
 */
describe("App", () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
    stubFetch({
      "GET /api/v1/health": () => ({ json: { status: "ok" } }),
    });
  });

  afterEach(() => {
    __resetSessionStoreForTests();
  });

  it("renders the application shell and home page", async () => {
    renderWithProviders(routes, { initialPath: "/" });

    // AppShell landmarks
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();

    // Signed-out navigation
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/signup");

    // HomePage content
    expect(screen.getByRole("heading", { level: 1, name: "TrafficVaultHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-check" })).toBeInTheDocument();

    // Health probe result surfaces from the (stubbed) API call
    expect(await screen.findByText("Backend responded: status = ok")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("renders the not-found page for unknown routes", () => {
    renderWithProviders(routes, { initialPath: "/this-route-does-not-exist" });

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return home" })).toHaveAttribute("href", "/");
  });
});
