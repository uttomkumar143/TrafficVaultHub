/**
 * Shared test helpers: a JSON `fetch` stub driven by a route table and a
 * render helper that mounts the real providers (QueryClient + AuthProvider)
 * under a MemoryRouter. No fabricated business data — fixtures describe only
 * identity/organization shapes that the backend actually returns.
 */
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import { vi } from "vitest";
import { AuthProvider } from "@/features/auth/auth-context";
import type { PublicOrganization, PublicUser, SessionInfo, TenantMeResponse } from "@/types/api";

export type FetchHandler = (req: {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}) => { status?: number; json?: unknown } | Response | Promise<{ status?: number; json?: unknown } | Response>;

export interface FetchStub {
  calls: Array<{ method: string; path: string; body: unknown; headers: Headers }>;
  mock: ReturnType<typeof vi.fn>;
}

export function errorEnvelope(code: string, message = code) {
  return { error: { code, message, request_id: "test-request" } };
}

/**
 * Install a `fetch` stub. `routes` maps `"METHOD /api/v1/path"` to a handler.
 * Unmatched requests answer 404 with the PRD §72 envelope.
 */
export function stubFetch(routes: Record<string, FetchHandler>): FetchStub {
  const calls: FetchStub["calls"] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    calls.push({ method, path, body, headers });

    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${path.split("?")[0]}`];
    if (!handler) {
      return jsonResponse(404, errorEnvelope("NOT_FOUND", "Resource not found"));
    }
    const result = await handler({ method, path, body, headers });
    if (result instanceof Response) return result;
    const status = result.status ?? 200;
    if (status === 204) return new Response(null, { status: 204 });
    return jsonResponse(status, result.json ?? {});
  });
  vi.stubGlobal("fetch", mock);
  return { calls, mock };
}

export function jsonResponse(status: number, json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

export interface RenderOptions {
  initialPath?: string;
  queryClient?: QueryClient;
}

/** Render a route table with the real providers under a MemoryRouter. */
export function renderWithProviders(routes: RouteObject[], options: RenderOptions = {}) {
  const queryClient = options.queryClient ?? makeQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [options.initialPath ?? "/"] });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}

/** Render a bare element under providers (no router). */
export function renderElement(element: ReactElement, queryClient = makeQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{element}</AuthProvider>
    </QueryClientProvider>,
  );
}

// ---- fixtures ---------------------------------------------------------------

export const FIXED_TIME = "2026-09-23T00:00:00.000Z";

export function makeUser(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "alice@example.com",
    display_name: "Alice",
    email_verified: true,
    status: "ACTIVE",
    timezone: "UTC",
    locale: "en",
    last_login_at: FIXED_TIME,
    created_at: FIXED_TIME,
    mfa: { enabled: false, available: false, reason: "NOT_IMPLEMENTED" },
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    created_at: FIXED_TIME,
    last_seen_at: FIXED_TIME,
    expires_at: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

export const ORG_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ORG_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export function makeOrganization(overrides: Partial<PublicOrganization> = {}): PublicOrganization {
  return {
    id: ORG_A_ID,
    type: "AFFILIATE",
    name: "Acme Affiliates",
    slug: "acme-affiliates",
    status: "ACTIVE",
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    membership: {
      id: "33333333-3333-4333-8333-333333333333",
      role: { key: "AFFILIATE_OWNER", name: "Affiliate Owner", is_owner: true },
      joined_at: FIXED_TIME,
    },
    ...overrides,
  };
}

export function makeTenantMe(overrides: Partial<TenantMeResponse> = {}): TenantMeResponse {
  return {
    organization: { id: ORG_A_ID, type: "AFFILIATE", name: "Acme Affiliates" },
    membership: { id: "33333333-3333-4333-8333-333333333333", joined_at: FIXED_TIME },
    role: { key: "AFFILIATE_OWNER", is_owner: true },
    permissions: ["members.manage", "members.read", "organizations.read", "organizations.update"],
    ...overrides,
  };
}
