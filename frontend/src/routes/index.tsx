import { createBrowserRouter, type RouteObject } from "react-router";
import { AppShell } from "@/components/layout/app-shell";
import { HomePage } from "@/routes/home/home-page";
import { NotFoundPage } from "@/routes/not-found-page";
import { LoginPage } from "@/routes/auth/login-page";
import { SignupPage } from "@/routes/auth/signup-page";
import { VerifyEmailPage } from "@/routes/auth/verify-email-page";
import { ForgotPasswordPage } from "@/routes/auth/forgot-password-page";
import { ResetPasswordPage } from "@/routes/auth/reset-password-page";
import { RequireAuth } from "@/components/auth/require-auth";
import { AuthenticatedShell } from "@/components/layout/authenticated-shell";
import { AppIndexPage } from "@/routes/app/app-index-page";
import { CreateOrganizationPage } from "@/routes/app/create-organization-page";
import { OrganizationOverviewPage } from "@/routes/app/organization-overview-page";
import { MembersPage } from "@/routes/app/members-page";
import { OffersPage } from "@/routes/app/offers-page";
import { CreateOfferPage } from "@/routes/app/create-offer-page";
import { OfferDetailPage } from "@/routes/app/offer-detail-page";
import { MarketplacePage } from "@/routes/app/marketplace-page";
import { MarketplaceOfferPage } from "@/routes/app/marketplace-offer-page";

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
  {
    // Authenticated product area (Phase 1 Unit 7). `RequireAuth` redirects
    // signed-out visitors to /login with `state.from`; the server remains the
    // authority for every request made from here.
    path: "/app",
    element: (
      <RequireAuth>
        <AuthenticatedShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <AppIndexPage /> },
      { path: "organizations/new", element: <CreateOrganizationPage /> },
      { path: ":orgId", element: <OrganizationOverviewPage /> },
      { path: ":orgId/members", element: <MembersPage /> },
      // Phase 2 — advertiser/agency offer management (offers.read/create/update/pause)
      { path: ":orgId/offers", element: <OffersPage /> },
      { path: ":orgId/offers/new", element: <CreateOfferPage /> },
      { path: ":orgId/offers/:offerId", element: <OfferDetailPage /> },
      // Phase 2 — affiliate/partner marketplace (offers.read; confidential-safe projection)
      { path: ":orgId/marketplace", element: <MarketplacePage /> },
      { path: ":orgId/marketplace/:offerId", element: <MarketplaceOfferPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
