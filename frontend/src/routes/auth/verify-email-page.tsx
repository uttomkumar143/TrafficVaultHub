import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { AuthLayout } from "@/components/layout/auth-layout";
import { FormField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import * as authApi from "@/features/auth/api";
import {
  emailOnlySchema,
  verifyEmailSchema,
  type EmailOnlyFormValues,
  type VerifyEmailFormValues,
} from "@/features/auth/schemas";
import { errorMessage } from "@/lib/error-message";

interface LocationState {
  token?: string;
  email?: string;
}

/**
 * Email verification. Accepts the token from `?token=` (link in the email),
 * from router state (dev flow) or typed manually. Also hosts the
 * "resend verification" form (202 — never reveals whether the email exists).
 */
export function VerifyEmailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const state = (location.state ?? {}) as LocationState;
  const initialToken = params.get("token") ?? state.token ?? "";

  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sent" | "error">("idle");
  const [resendError, setResendError] = useState<string | null>(null);
  const autoSubmitted = useRef(false);

  const verifyForm = useForm<VerifyEmailFormValues>({
    resolver: zodResolver(verifyEmailSchema),
    defaultValues: { token: initialToken },
  });
  const resendForm = useForm<EmailOnlyFormValues>({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: state.email ?? "" },
  });

  const onVerify = verifyForm.handleSubmit(async ({ token }) => {
    setVerifyError(null);
    try {
      await authApi.verifyEmail(token);
      navigate("/login", { replace: true, state: { notice: "Email verified. You can sign in now." } });
    } catch (err) {
      setVerifyError(errorMessage(err));
    }
  });

  // Auto-submit exactly once when a token arrived via link/state.
  useEffect(() => {
    if (initialToken && !autoSubmitted.current) {
      autoSubmitted.current = true;
      void onVerify();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialToken]);

  const onResend = resendForm.handleSubmit(async ({ email }) => {
    setResendError(null);
    try {
      await authApi.resendVerification(email);
      setResendState("sent");
    } catch (err) {
      setResendState("error");
      setResendError(errorMessage(err));
    }
  });

  const verifying = verifyForm.formState.isSubmitting;

  return (
    <AuthLayout
      title="Verify your email"
      description="Paste the verification code from your email, or request a new one."
      footer={
        <Link to="/login" className="underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      <div className="space-y-8">
        <form id="verify-email-form" onSubmit={onVerify} noValidate className="space-y-4">
          {verifyError ? (
            <Alert variant="destructive">
              <AlertDescription>{verifyError}</AlertDescription>
            </Alert>
          ) : null}
          <FormField
            label="Verification code"
            autoComplete="one-time-code"
            error={verifyForm.formState.errors.token?.message}
            {...verifyForm.register("token")}
          />
          <Button type="submit" className="w-full" disabled={verifying}>
            {verifying ? "Verifying…" : "Verify email"}
          </Button>
        </form>

        <form id="resend-verification-form" onSubmit={onResend} noValidate className="space-y-4 border-t pt-6">
          <h2 className="text-sm font-medium">Didn&apos;t receive the email?</h2>
          {resendState === "sent" ? (
            <Alert variant="success">
              <AlertDescription>
                If an unverified account exists for that address, a new verification email is on its way.
              </AlertDescription>
            </Alert>
          ) : null}
          {resendState === "error" && resendError ? (
            <Alert variant="destructive">
              <AlertDescription>{resendError}</AlertDescription>
            </Alert>
          ) : null}
          <FormField
            label="Email"
            type="email"
            autoComplete="email"
            error={resendForm.formState.errors.email?.message}
            {...resendForm.register("email")}
          />
          <Button type="submit" variant="outline" className="w-full" disabled={resendForm.formState.isSubmitting}>
            {resendForm.formState.isSubmitting ? "Sending…" : "Resend verification email"}
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
