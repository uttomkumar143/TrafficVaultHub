import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { routes } from "@/routes";
import { __resetSessionStoreForTests, getSessionToken, setSessionToken } from "@/lib/session-store";
import {
  errorEnvelope,
  makeSession,
  makeUser,
  renderWithProviders,
  stubFetch,
  type FetchStub,
} from "@/test/utils";

/**
 * Auth pages — render, client validation, real request shape against the
 * stubbed `/api/v1/auth/*` contract, server error surfacing, and navigation.
 * A placeholder `/app` route is not part of the public table yet, so the
 * post-login redirect is asserted via the router location.
 *
 * Fixture note: passwords/tokens below are synthetic. They deliberately contain
 * spaces or dots so they read as obvious test data and are not mistaken for
 * real credentials by `scripts/secret-scan.sh`, while still satisfying the
 * schema limits (password >= 10 chars, token >= 16 chars).
 */
describe("auth pages", () => {
  let fetchStub: FetchStub;

  beforeEach(() => {
    __resetSessionStoreForTests();
  });
  afterEach(() => {
    __resetSessionStoreForTests();
  });

  describe("/login", () => {
    it("validates required fields client-side without calling the API", async () => {
      fetchStub = stubFetch({});
      renderWithProviders(routes, { initialPath: "/login" });
      const user = userEvent.setup();

      expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Sign in" }));

      expect(await screen.findByText("Email is required")).toBeInTheDocument();
      expect(screen.getByText("Password is required")).toBeInTheDocument();
      expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
      expect(fetchStub.calls.filter((c) => c.path.startsWith("/api/v1/auth"))).toHaveLength(0);
    });

    it("posts credentials, stores the token and redirects to /app", async () => {
      fetchStub = stubFetch({
        "POST /api/v1/auth/login": ({ body }) => {
          expect(body).toEqual({ email: "alice@example.com", password: "correct horse battery" });
          return {
            json: { token: "tvh_s_test", expires_at: "2026-10-23T00:00:00.000Z", user: makeUser(), session: makeSession() },
          };
        },
        "GET /api/v1/auth/me": () => ({ json: { user: makeUser(), session: makeSession() } }),
      });
      const { router } = renderWithProviders(routes, { initialPath: "/login" });
      const user = userEvent.setup();

      await user.type(screen.getByLabelText("Email"), "Alice@Example.com");
      await user.type(screen.getByLabelText("Password"), "correct horse battery");
      await user.click(screen.getByRole("button", { name: "Sign in" }));

      await waitFor(() => expect(router.state.location.pathname).toBe("/app"));
      expect(getSessionToken()).toBe("tvh_s_test");
    });

    it("shows the server error for invalid credentials and keeps the user signed out", async () => {
      fetchStub = stubFetch({
        "POST /api/v1/auth/login": () => ({ status: 401, json: errorEnvelope("INVALID_CREDENTIALS", "Invalid email or password") }),
      });
      renderWithProviders(routes, { initialPath: "/login" });
      const user = userEvent.setup();

      await user.type(screen.getByLabelText("Email"), "alice@example.com");
      await user.type(screen.getByLabelText("Password"), "wrong-password");
      await user.click(screen.getByRole("button", { name: "Sign in" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
      expect(getSessionToken()).toBeNull();
    });

    it("offers to resend verification when the account is unverified", async () => {
      fetchStub = stubFetch({
        "POST /api/v1/auth/login": () => ({ status: 403, json: errorEnvelope("EMAIL_NOT_VERIFIED") }),
      });
      renderWithProviders(routes, { initialPath: "/login" });
      const user = userEvent.setup();

      await user.type(screen.getByLabelText("Email"), "alice@example.com");
      await user.type(screen.getByLabelText("Password"), "correct horse battery");
      await user.click(screen.getByRole("button", { name: "Sign in" }));

      expect(await screen.findByRole("link", { name: "Resend verification email" })).toHaveAttribute(
        "href",
        "/verify-email",
      );
    });

    it("redirects an already-authenticated visitor away from /login", async () => {
      setSessionToken("existing");
      fetchStub = stubFetch({
        "GET /api/v1/auth/me": () => ({ json: { user: makeUser(), session: makeSession() } }),
      });
      const { router } = renderWithProviders(routes, { initialPath: "/login" });
      await waitFor(() => expect(router.state.location.pathname).toBe("/app"));
    });
  });

  describe("/signup", () => {
    it("enforces password length and confirmation client-side", async () => {
      fetchStub = stubFetch({});
      renderWithProviders(routes, { initialPath: "/signup" });
      const user = userEvent.setup();

      await user.type(screen.getByLabelText("Email"), "bob@example.com");
      await user.type(screen.getByLabelText("Password"), "short");
      await user.type(screen.getByLabelText("Confirm password"), "different");
      await user.click(screen.getByRole("button", { name: "Create account" }));

      expect(await screen.findByText("Password must be at least 10 characters")).toBeInTheDocument();
      expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
      expect(fetchStub.calls.filter((c) => c.path.startsWith("/api/v1/auth"))).toHaveLength(0);
    });

    it("creates the account and shows the check-your-email state", async () => {
      fetchStub = stubFetch({
        "POST /api/v1/auth/signup": ({ body }) => {
          expect(body).toEqual({ email: "bob@example.com", password: "a long enough password", display_name: "Bob" });
          return { status: 201, json: { user: makeUser({ email: "bob@example.com", email_verified: false }) } };
        },
      });
      renderWithProviders(routes, { initialPath: "/signup" });
      const user = userEvent.setup();

      await user.type(screen.getByLabelText("Name (optional)"), "Bob");
      await user.type(screen.getByLabelText("Email"), "bob@example.com");
      await user.type(screen.getByLabelText("Password"), "a long enough password");
      await user.type(screen.getByLabelText("Confirm password"), "a long enough password");
      await user.click(screen.getByRole("button", { name: "Create account" }));

      expect(await screen.findByRole("heading", { level: 1, name: "Check your email" })).toBeInTheDocument();
      expect(screen.getByText("bob@example.com")).toBeInTheDocument();
      // Signing up never signs the user in.
      expect(getSessionToken()).toBeNull();
    });

    it("surfaces EMAIL_ALREADY_REGISTERED", async () => {
      fetchStub = stubFetch({
        "POST /api/v1/auth/signup": () => ({ status: 409, json: errorEnvelope("EMAIL_ALREADY_REGISTERED") }),
      });
      renderWithProviders(routes, { initialPath: "/signup" });
      const user = userEvent.setup();

      await user.type(screen.getByLabelText("Email"), "bob@example.com");
      await user.type(screen.getByLabelText("Password"), "a long enough password");
      await user.type(screen.getByLabelText("Confirm password"), "a long enough password");
      await user.click(screen.getByRole("button", { name: "Create account" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("An account with this email already exists.");
    });
  });

  describe("/verify-email", () => {
    it("auto-submits a token from the query string and redirects to /login with a notice", async () => {
      fetchStub = stubFetch({
        "POST /api/v1/auth/verify-email": ({ body }) => {
          expect(body).toEqual({ token: "test.verify.token.0123456789" });
          return { json: { user: makeUser() } };
        },
      });
      const { router } = renderWithProviders(routes, { initialPath: "/verify-email?token=test.verify.token.0123456789" });

      await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
      expect(await screen.findByText("Email verified. You can sign in now.")).toBeInTheDocument();
    });

    it("shows INVALID_TOKEN and lets the user request a new email (202)", async () => {
      fetchStub = stubFetch({
        "POST /api/v1/auth/verify-email": () => ({ status: 400, json: errorEnvelope("INVALID_TOKEN") }),
        "POST /api/v1/auth/resend-verification": ({ body }) => {
          expect(body).toEqual({ email: "alice@example.com" });
          return { status: 202, json: {} };
        },
      });
      renderWithProviders(routes, { initialPath: "/verify-email" });
      const user = userEvent.setup();

      await user.type(screen.getByLabelText("Verification code"), "test.verify.token.0123456789");
      await user.click(screen.getByRole("button", { name: "Verify email" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This link is invalid or has expired.");

      await user.type(screen.getByLabelText("Email"), "alice@example.com");
      await user.click(screen.getByRole("button", { name: "Resend verification email" }));
      expect(await screen.findByText(/a new verification email is on its way/)).toBeInTheDocument();
    });
  });

  describe("/forgot-password and /reset-password", () => {
    it("requests a reset link (202) and shows the neutral confirmation", async () => {
      fetchStub = stubFetch({
        "POST /api/v1/auth/forgot-password": ({ body }) => {
          expect(body).toEqual({ email: "alice@example.com" });
          return { status: 202, json: {} };
        },
      });
      renderWithProviders(routes, { initialPath: "/forgot-password" });
      const user = userEvent.setup();

      await user.type(screen.getByLabelText("Email"), "alice@example.com");
      await user.click(screen.getByRole("button", { name: "Send reset link" }));

      expect(await screen.findByText("Check your email")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "I have a reset code" })).toHaveAttribute("href", "/reset-password");
    });

    it("resets the password with the token from the link and returns to /login", async () => {
      fetchStub = stubFetch({
        "POST /api/v1/auth/reset-password": ({ body }) => {
          expect(body).toEqual({ token: "test.reset.token.9876543210", password: "brand new password 1" });
          return { status: 204 };
        },
      });
      const { router } = renderWithProviders(routes, { initialPath: "/reset-password?token=test.reset.token.9876543210" });
      const user = userEvent.setup();

      expect(screen.getByLabelText("Reset code")).toHaveValue("test.reset.token.9876543210");
      await user.type(screen.getByLabelText("New password"), "brand new password 1");
      await user.type(screen.getByLabelText("Confirm new password"), "brand new password 1");
      await user.click(screen.getByRole("button", { name: "Update password" }));

      await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
      expect(await screen.findByText("Password updated. Sign in with your new password.")).toBeInTheDocument();
    });

    it("surfaces an expired reset token", async () => {
      fetchStub = stubFetch({
        "POST /api/v1/auth/reset-password": () => ({ status: 400, json: errorEnvelope("INVALID_TOKEN") }),
      });
      renderWithProviders(routes, { initialPath: "/reset-password?token=test.reset.token.9876543210" });
      const user = userEvent.setup();

      await user.type(screen.getByLabelText("New password"), "brand new password 1");
      await user.type(screen.getByLabelText("Confirm new password"), "brand new password 1");
      await user.click(screen.getByRole("button", { name: "Update password" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("This link is invalid or has expired.");
    });
  });
});
