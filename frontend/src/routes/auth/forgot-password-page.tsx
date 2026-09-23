import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "react-router";
import { AuthLayout } from "@/components/layout/auth-layout";
import { FormField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import * as authApi from "@/features/auth/api";
import { emailOnlySchema, type EmailOnlyFormValues } from "@/features/auth/schemas";
import { errorMessage } from "@/lib/error-message";

/** Password reset request. The API answers 202 regardless (no enumeration). */
export function ForgotPasswordPage() {
  const [serverError, setServerError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const form = useForm<EmailOnlyFormValues>({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: "" },
  });

  const onSubmit = form.handleSubmit(async ({ email }) => {
    setServerError(null);
    try {
      await authApi.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });

  return (
    <AuthLayout
      title="Reset your password"
      description="Enter your email and we will send a reset link if an account exists."
      footer={
        <Link to="/login" className="underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <div className="space-y-4">
          <Alert variant="success">
            <AlertTitle>Check your email</AlertTitle>
            <AlertDescription>
              If an account exists for that address, a password reset link has been sent. The link expires in one
              hour.
            </AlertDescription>
          </Alert>
          <Link to="/reset-password" className="text-sm underline underline-offset-4">
            I have a reset code
          </Link>
        </div>
      ) : (
        <form id="forgot-password-form" onSubmit={onSubmit} noValidate className="space-y-4">
          {serverError ? (
            <Alert variant="destructive">
              <AlertDescription>{serverError}</AlertDescription>
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
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
