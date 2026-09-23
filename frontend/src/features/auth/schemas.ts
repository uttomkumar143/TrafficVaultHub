/**
 * Client-side validation schemas mirroring `backend/src/routes/auth.ts`.
 * They exist for immediate user feedback only — the server re-validates every
 * request (PRD §5). Keep limits identical to `modules/auth/constants.ts`.
 */
import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

export const emailField = z
  .string()
  .trim()
  .min(1, "Email is required")
  .max(254, "Email is too long")
  .email("Enter a valid email address")
  .toLowerCase();

export const passwordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Password is required").max(PASSWORD_MAX_LENGTH),
});
export type LoginFormValues = z.infer<typeof loginSchema>;

export const signupSchema = z
  .object({
    display_name: z.string().trim().max(120, "Name is too long"),
    email: emailField,
    password: passwordField,
    confirm_password: z.string(),
  })
  .refine((v) => v.password === v.confirm_password, {
    message: "Passwords do not match",
    path: ["confirm_password"],
  });
export type SignupFormValues = z.infer<typeof signupSchema>;

export const emailOnlySchema = z.object({ email: emailField });
export type EmailOnlyFormValues = z.infer<typeof emailOnlySchema>;

export const tokenField = z.string().trim().min(16, "Token looks incomplete").max(512, "Token is too long");

export const verifyEmailSchema = z.object({ token: tokenField });
export type VerifyEmailFormValues = z.infer<typeof verifyEmailSchema>;

export const resetPasswordSchema = z
  .object({
    token: tokenField,
    password: passwordField,
    confirm_password: z.string(),
  })
  .refine((v) => v.password === v.confirm_password, {
    message: "Passwords do not match",
    path: ["confirm_password"],
  });
export type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>;
