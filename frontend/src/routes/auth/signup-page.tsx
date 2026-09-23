import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, Navigate } from "react-router";
import { AuthLayout } from "@/components/layout/auth-layout";
import { FormField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAuth } from "@/features/auth/use-auth";
import * as authApi from "@/features/auth/api";
import { PASSWORD_MIN_LENGTH, signupSchema, type SignupFormValues } from "@/features/auth/schemas";
import { errorMessage } from "@/lib/error-message";
import { DEFAULT_AUTHENTICATED_PATH } from "@/routes/auth/login-page";
import type { SignupResponse } from "@/types/api";

export function SignupPage() {
  const auth = useAuth();
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<SignupResponse | null>(null);

  const form = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: { display_name: "", email: "", password: "", confirm_password: "" },
  });

  if (auth.status === "authenticated") {
    return <Navigate to={DEFAULT_AUTHENTICATED_PATH} replace />;
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      const res = await authApi.signup({
        email: values.email,
        password: values.password,
        display_name: values.display_name.trim() || undefined,
      });
      setResult(res);
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });

  if (result) {
    return (
      <AuthLayout title="Check your email">
        <div className="space-y-4">
          <Alert variant="success">
            <AlertTitle>Account created</AlertTitle>
            <AlertDescription>
              <p>
                We sent a verification link to <strong>{result.user.email}</strong>. Open it to activate your
                account, then sign in.
              </p>
            </AlertDescription>
          </Alert>
          {result.debug?.verification_token ? (
            // Only present when the backend runs with APP_ENV=development.
            <p className="text-xs text-muted-foreground break-all">
              Development mode — verification token:{" "}
              <Link
                to="/verify-email"
                state={{ token: result.debug.verification_token }}
                className="underline underline-offset-4"
              >
                verify now
              </Link>
            </p>
          ) : null}
          <div className="flex flex-col gap-2 text-sm">
            <Link to="/verify-email" state={{ email: result.user.email }} className="underline underline-offset-4">
              I have a verification code
            </Link>
            <Link to="/login" className="underline underline-offset-4">
              Back to sign in
            </Link>
          </div>
        </div>
      </AuthLayout>
    );
  }

  const busy = form.formState.isSubmitting;

  return (
    <AuthLayout
      title="Create your account"
      description="Start as an advertiser or affiliate — you will create or join an organization after signing in."
      footer={
        <>
          Already registered?{" "}
          <Link to="/login" className="underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      <form id="signup-form" onSubmit={onSubmit} noValidate className="space-y-4">
        {serverError ? (
          <Alert variant="destructive">
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        ) : null}

        <FormField
          label="Name (optional)"
          autoComplete="name"
          error={form.formState.errors.display_name?.message}
          {...form.register("display_name")}
        />
        <FormField
          label="Email"
          type="email"
          autoComplete="email"
          error={form.formState.errors.email?.message}
          {...form.register("email")}
        />
        <FormField
          label="Password"
          type="password"
          autoComplete="new-password"
          description={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={form.formState.errors.password?.message}
          {...form.register("password")}
        />
        <FormField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          error={form.formState.errors.confirm_password?.message}
          {...form.register("confirm_password")}
        />

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
