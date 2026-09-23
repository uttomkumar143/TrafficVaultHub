import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate } from "react-router";
import { FormField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useCreateOrganization } from "@/features/organizations/hooks";
import { createOrganizationSchema, type CreateOrganizationFormValues } from "@/features/organizations/schemas";
import { errorMessage } from "@/lib/error-message";
import { SELF_SERVICE_ORG_TYPES } from "@/types/api";

const TYPE_LABELS: Record<(typeof SELF_SERVICE_ORG_TYPES)[number], string> = {
  ADVERTISER: "Advertiser — run performance campaigns",
  AFFILIATE: "Affiliate — promote offers and earn commissions",
  PARTNER: "Partner",
  AGENCY: "Agency",
};

/** `/app/organizations/new` — POST /organizations; creator is seated as owner. */
export function CreateOrganizationPage() {
  const navigate = useNavigate();
  const create = useCreateOrganization();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<CreateOrganizationFormValues>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: { type: "AFFILIATE", name: "", slug: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      const { organization } = await create.mutateAsync({
        type: values.type,
        name: values.name,
        ...(values.slug ? { slug: values.slug } : {}),
      });
      navigate(`/app/${organization.id}`, { replace: true });
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });

  const typeId = "create-org-type";
  const errors = form.formState.errors;

  return (
    <section id="create-organization-section" className="mx-auto max-w-lg space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Create organization</h1>
        <p className="text-sm text-muted-foreground">You will become its owner and can add members afterwards.</p>
      </header>

      <form id="create-organization-form" onSubmit={onSubmit} noValidate className="space-y-4 rounded-lg border bg-card p-6">
        {serverError ? (
          <Alert variant="destructive">
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor={typeId}>Type</Label>
          <select
            id={typeId}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            aria-invalid={errors.type ? true : undefined}
            {...form.register("type")}
          >
            {SELF_SERVICE_ORG_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {errors.type ? (
            <p role="alert" className="text-xs text-destructive">
              {errors.type.message}
            </p>
          ) : null}
        </div>

        <FormField label="Name" autoComplete="organization" error={errors.name?.message} {...form.register("name")} />
        <FormField
          label="Slug (optional)"
          description="Lowercase letters, digits and hyphens. Generated from the name when left blank."
          error={errors.slug?.message}
          {...form.register("slug")}
        />

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={create.isPending || form.formState.isSubmitting}>
            {create.isPending ? "Creating…" : "Create organization"}
          </Button>
          <Link to="/app" className="text-sm underline underline-offset-4">
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}
