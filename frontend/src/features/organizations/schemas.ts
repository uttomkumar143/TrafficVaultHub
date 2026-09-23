/**
 * Client-side validation mirroring `backend/src/routes/organizations.ts`.
 * Immediate feedback only — the server re-validates every request (PRD §5).
 */
import { z } from "zod";
import { SELF_SERVICE_ORG_TYPES } from "@/types/api";
import { emailField } from "@/features/auth/schemas";

export const orgNameField = z.string().trim().min(2, "Name must be at least 2 characters").max(120, "Name is too long");

export const orgSlugField = z
  .string()
  .trim()
  .toLowerCase()
  .max(64, "Slug is too long")
  .regex(/^$|^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and single hyphens")
  .refine((v) => v.length === 0 || v.length >= 2, "Slug must be at least 2 characters");

export const createOrganizationSchema = z.object({
  type: z.enum(SELF_SERVICE_ORG_TYPES, { message: "Choose an organization type" }),
  name: orgNameField,
  slug: orgSlugField,
});
export type CreateOrganizationFormValues = z.infer<typeof createOrganizationSchema>;

export const roleKeyField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z_]{1,63}$/, "Choose a role");

export const addMemberSchema = z.object({
  email: emailField,
  role: roleKeyField,
});
export type AddMemberFormValues = z.infer<typeof addMemberSchema>;
