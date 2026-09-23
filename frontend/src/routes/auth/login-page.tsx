import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { AuthLayout } from "@/components/layout/auth-layout";
import { FormField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/features/auth/use-auth";
import { loginSchema, type LoginFormValues } from "@/features/auth/schemas";
import { errorMessage } from "@/lib/error-message";
import { isApiError } from "@/lib/api";

/** Where to land after sign-in when no `from` was supplied by a guard. */
export const DEFAULT_AUTHENTICATED_PATH = "/app";

interface LocationState {
  from?: string;
  notice?: string;
}

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as LocationState;
  const [serverError, setServerError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  if (auth.status === "authenticated") {
    return <Navigate to={state.from ?? DEFAULT_AUTHENTICATED_PATH} replace />;
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    setUnverifiedEmail(null);
    try {
      await auth.login(values);
      navigate(state.from ?? DEFAULT_AUTHENTICATED_PATH, { replace: true });
    } catch (err) {
      if (isApiError(err) && err.code === "EMAIL_NOT_VERIFIED") setUnverifiedEmail(values.email);
      setServerError(errorMessage(err));
    }
  });

  const busy = auth.isLoggingIn || form.formState.isSubmitting;

  return (
    <AuthLayout
      title="Sign in"
      description="Use the email and password you registered with."
      footer={
        <>
          New to TrafficVaultHub?{" "}
          <Link to="/signup" className="underline underline-offset-4">
            Create an account
          </Link>
        </>
      }
    >
      <form id="login-form" onSubmit={onSubmit} noValidate className="space-y-4">
        {state.notice ? (
          <Alert variant="success">
            <AlertDescription>{state.notice}</AlertDescription>
          </Alert>
        ) : null}
        {serverError ? (
          <Alert variant="destructive">
            <AlertDescription>
              <p>{serverError}</p>
              {unverifiedEmail ? (
                <Link
                  to="/verify-email"
                  state={{ email: unverifiedEmail }}
                  className="underline underline-offset-4"
                >
                  Resend verification email
                </Link>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <FormField
          label="Email"
          type="email"
          autoComplete="email"
          autoFocus
          error={form.formState.errors.email?.message}
          {...form.register("email")}
        />
        <FormField
          label="Password"
          type="password"
          autoComplete="current-password"
          error={form.formState.errors.password?.message}
          {...form.register("password")}
        />

        <div className="flex items-center justify-between text-sm">
          <Link to="/forgot-password" className="underline underline-offset-4">
            Forgot password?
          </Link>
        </div>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
