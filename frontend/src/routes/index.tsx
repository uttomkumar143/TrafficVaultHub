import { createBrowserRouter, type RouteObject } from "react-router";
import { AppShell } from "@/components/layout/app-shell";
import { HomePage } from "@/routes/home/home-page";
import { NotFoundPage } from "@/routes/not-found-page";
import { LoginPage } from "@/routes/auth/login-page";
import { SignupPage } from "@/routes/auth/signup-page";
import { VerifyEmailPage } from "@/routes/auth/verify-email-page";
import { ForgotPasswordPage } from "@/routes/auth/forgot-password-page";
import { ResetPasswordPage } from "@/routes/auth/reset-password-page";

/** Route table. Additional feature routes are registered here in later phases. */
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      // Public authentication flows (Phase 1 Unit 7)
      { path: "login", element: <LoginPage /> },
      { path: "signup", element: <SignupPage /> },
      { path: "verify-email", element: <VerifyEmailPage /> },
      { path: "forgot-password", element: <ForgotPasswordPage /> },
      { path: "reset-password", element: <ResetPasswordPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
