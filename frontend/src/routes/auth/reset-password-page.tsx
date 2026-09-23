import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate, useSearchParams } from "react-router";
import { AuthLayout } from "@/components/layout/auth-layout";
import { FormField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import * as authApi from "@/features/auth/api";
import {
  PASSWORD_MIN_LENGTH,
  resetPasswordSchema,
  type ResetPasswordFormValues,
} from "@/features/auth/schemas";
import { errorMessage } from "@/lib/error-message";

/** Complete a password reset with the one-time token from the email link. */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token: params.get("token") ?? "", password: "", confirm_password: "" },
  });

  const onSubmit = form.handleSubmit(async ({ token, password }) => {
    setServerError(null);
    try {
      await authApi.resetPassword({ token, password });
      navigate("/login", {
        replace: true,
        state: { notice: "Password updated. Sign in with your new password." },
      });
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });

  return (
    <AuthLayout
      title="Choose a new password"
      footer={
        <Link to="/forgot-password" className="underline underline-offset-4">
          Request a new reset link
        </Link>
      }
    >
      <form id="reset-password-form" onSubmit={onSubmit} noValidate className="space-y-4">
        {serverError ? (
          <Alert variant="destructive">
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        ) : null}
        <FormField
          label="Reset code"
          autoComplete="one-time-code"
          error={form.formState.errors.token?.message}
          {...form.register("token")}
        />
        <FormField
          label="New password"
          type="password"
          autoComplete="new-password"
          description={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={form.formState.errors.password?.message}
          {...form.register("password")}
        />
        <FormField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          error={form.formState.errors.confirm_password?.message}
          {...form.register("confirm_password")}
        />
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Updating…" : "Update password"}
        </Button>
      </form>
    </AuthLayout>
  );
}
