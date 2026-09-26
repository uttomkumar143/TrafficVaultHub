import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useNavigate, useParams } from "react-router";
import { FormField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useTenant } from "@/features/organizations/hooks";
import { useCreateOffer } from "@/features/offers/hooks";
import {
  DEFAULT_VERSION_FORM,
  createOfferFormSchema,
  toCreatePayload,
  versionFormSchema,
} from "@/features/offers/schemas";
import { VersionFormFields } from "@/features/offers/version-form-fields";
import { ACCESS_MODE_LABELS, selectClassName, textareaClassName } from "@/features/offers/presentation";
import { NotAMember } from "@/routes/app/organization-overview-page";
import { errorMessage } from "@/lib/error-message";
import { ACCESS_MODES } from "@/types/api";

/** Offer identity + version 1 in one form; validated by the two existing schemas. */
const formSchema = createOfferFormSchema.extend({ version: versionFormSchema });
type FormValues = z.infer<typeof formSchema>;

/**
 * `/app/:orgId/offers/new` — `POST /organizations/:orgId/offers` (`offers.create`).
 * Creates a DRAFT offer with its immutable version 1 (PRD §22, §24). The
 * payload carries integer minor units + currency only and never any
 * organization/advertiser id — the server derives those from the path and
 * the session (PRD §25, §94). On success we land on the new offer's detail.
 */
export function CreateOfferPage() {
  const { orgId = "" } = useParams<{ orgId: string }>();
  const navigate = useNavigate();
  const tenant = useTenant(orgId);
  const create = useCreateOffer(orgId);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", vertical: "", description: "", access_mode: "PUBLIC", version: DEFAULT_VERSION_FORM },
  });
  const errors = form.formState.errors;

  if (tenant.isNotMember) return <NotAMember />;
  if (tenant.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }
  if (tenant.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{errorMessage(tenant.error)}</AlertDescription>
      </Alert>
    );
  }
  if (tenant.tenant && !tenant.can("offers.create")) {
    return (
      <section id="create-offer-forbidden-section" className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold">Create offer</h1>
        <Alert variant="destructive">
          <AlertDescription>You do not have permission to create offers in this organization.</AlertDescription>
        </Alert>
        <Link to={`/app/${orgId}/offers`} className="text-sm underline underline-offset-4">
          Back to offers
        </Link>
      </section>
    );
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      const { version, ...offer } = values;
      const { offer: created } = await create.mutateAsync(toCreatePayload(offer, version));
      navigate(`/app/${orgId}/offers/${created.id}`, { replace: true });
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });

  const accessModeId = "create-offer-access-mode";
  const descriptionId = "create-offer-description";
  const busy = create.isPending || form.formState.isSubmitting;

  return (
    <section id="create-offer-section" className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Create offer</h1>
        <p className="text-sm text-muted-foreground">
          The offer starts as a draft with version 1 of its terms. Submit it for platform review when ready.
        </p>
      </header>

      <form id="create-offer-form" onSubmit={onSubmit} noValidate className="space-y-8 rounded-lg border bg-card p-6">
        {serverError ? (
          <Alert variant="destructive">
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        ) : null}

        <section aria-labelledby="create-offer-identity" className="space-y-4">
          <h2 id="create-offer-identity" className="text-sm font-medium">
            Offer
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Name" autoComplete="off" error={errors.name?.message} {...form.register("name")} />
            <FormField label="Vertical (optional)" placeholder="e.g. Finance" autoComplete="off" error={errors.vertical?.message} {...form.register("vertical")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={descriptionId}>Description (optional)</Label>
            <textarea
              id={descriptionId}
              className={textareaClassName}
              rows={3}
              aria-invalid={errors.description ? true : undefined}
              {...form.register("description")}
            />
            {errors.description ? (
              <p role="alert" className="text-xs text-destructive">
                {errors.description.message}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={accessModeId}>Access mode</Label>
            <select id={accessModeId} className={selectClassName} aria-invalid={errors.access_mode ? true : undefined} {...form.register("access_mode")}>
              {ACCESS_MODES.map((m) => (
                <option key={m} value={m}>
                  {ACCESS_MODE_LABELS[m]}
                </option>
              ))}
            </select>
            {errors.access_mode ? (
              <p role="alert" className="text-xs text-destructive">
                {errors.access_mode.message}
              </p>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="create-offer-version" className="space-y-4">
          <h2 id="create-offer-version" className="text-sm font-medium">
            Version 1 terms
          </h2>
          <VersionFormFields form={form} prefix="version" disabled={busy} hideChangeSummary />
        </section>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create offer"}
          </Button>
          <Link to={`/app/${orgId}/offers`} className="text-sm underline underline-offset-4">
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}
