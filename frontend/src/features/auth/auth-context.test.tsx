import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useAuth } from "@/features/auth/use-auth";
import { __resetSessionStoreForTests, getSessionToken, setSessionToken } from "@/lib/session-store";
import {
  errorEnvelope,
  makeSession,
  makeUser,
  renderElement,
  stubFetch,
  type FetchStub,
} from "@/test/utils";

/** Minimal consumer that exposes the context for assertions/interactions. */
function Probe() {
  const auth = useAuth();
  return (
    <div>
      <output data-testid="status">{auth.status}</output>
      <output data-testid="email">{auth.user?.email ?? ""}</output>
      <button onClick={() => void auth.login({ email: "alice@example.com", password: "correct horse" })}>
        do-login
      </button>
      <button onClick={() => void auth.logout()}>do-logout</button>
    </div>
  );
}

describe("AuthProvider", () => {
  let fetchStub: FetchStub;

  beforeEach(() => {
    __resetSessionStoreForTests();
  });

  afterEach(() => {
    __resetSessionStoreForTests();
  });

  it("is unauthenticated without a token and never calls /auth/me", async () => {
    fetchStub = stubFetch({});
    renderElement(<Probe />);
    expect(screen.getByTestId("status")).toHaveTextContent("unauthenticated");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchStub.calls.filter((c) => c.path === "/api/v1/auth/me")).toHaveLength(0);
  });

  it("restores a session from the stored token via GET /auth/me", async () => {
    setSessionToken("stored-token");
    fetchStub = stubFetch({
      "GET /api/v1/auth/me": ({ headers }) => {
        expect(headers.get("authorization")).toBe("Bearer stored-token");
        return { json: { user: makeUser(), session: makeSession() } };
      },
    });
    renderElement(<Probe />);
    expect(screen.getByTestId("status")).toHaveTextContent("loading");
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(screen.getByTestId("email")).toHaveTextContent("alice@example.com");
  });

  it("drops a token the server rejects with 401 and becomes unauthenticated", async () => {
    setSessionToken("revoked-token");
    fetchStub = stubFetch({
      "GET /api/v1/auth/me": () => ({ status: 401, json: errorEnvelope("UNAUTHENTICATED") }),
    });
    renderElement(<Probe />);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("unauthenticated"));
    expect(getSessionToken()).toBeNull();
  });

  it("login stores the token and exposes the user; logout revokes and clears", async () => {
    fetchStub = stubFetch({
      "POST /api/v1/auth/login": ({ body, headers }) => {
        expect(headers.get("authorization")).toBeNull();
        expect(body).toEqual({ email: "alice@example.com", password: "correct horse" });
        return { json: { token: "fresh-token", expires_at: "2026-10-23T00:00:00.000Z", user: makeUser(), session: makeSession() } };
      },
      "GET /api/v1/auth/me": () => ({ json: { user: makeUser(), session: makeSession() } }),
      "POST /api/v1/auth/logout": ({ headers }) => {
        expect(headers.get("authorization")).toBe("Bearer fresh-token");
        return { status: 204 };
      },
    });
    renderElement(<Probe />);

    await act(async () => {
      screen.getByRole("button", { name: "do-login" }).click();
    });
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(getSessionToken()).toBe("fresh-token");
    expect(screen.getByTestId("email")).toHaveTextContent("alice@example.com");

    await act(async () => {
      screen.getByRole("button", { name: "do-logout" }).click();
    });
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("unauthenticated"));
    expect(getSessionToken()).toBeNull();
    expect(fetchStub.calls.some((c) => c.method === "POST" && c.path === "/api/v1/auth/logout")).toBe(true);
  });

  it("useAuth throws outside of AuthProvider", () => {
    // Suppress React's error boundary noise for this assertion.
    const spy = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Probe />)).toThrow(/within <AuthProvider>/);
    } finally {
      console.error = spy;
    }
  });
});
