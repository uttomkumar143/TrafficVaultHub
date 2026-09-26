/**
 * Reusable react-hook-form fieldset for an offer version's economics and
 * targeting terms (PRD §22–§25). Used by the create-offer form and by the
 * "new version" form on the offer detail page.
 *
 * The form holds MAJOR-unit strings (e.g. "40.00"); conversion to integer
 * minor units happens in `schemas.ts#toVersionPayload` with string math. The
 * fieldset never sees or emits money floats.
 *
 * Form shape: `versionFormSchema` (features/offers/schemas.ts). When embedded
 * in a bigger form the caller passes `prefix` (e.g. "version") and the field
 * names become `version.payout_type`, …
 */
import { useId } from "react";
import type { FieldErrors, FieldValues, Path, UseFormReturn } from "react-hook-form";
import { FormField } from "@/components/forms/form-field";
import { Label } from "@/components/ui/label";
import { PAYOUT_TYPES, TARGETING_DIMENSIONS, type OfferVersion } from "@/types/api";
import type { VersionFormValues } from "@/features/offers/schemas";
import {
  DetailItem,
  PAYOUT_TYPE_LABELS,
  TARGETING_DIMENSION_LABELS,
  formatDateTime,
  selectClassName,
  textareaClassName,
} from "@/features/offers/presentation";
import { formatBps, formatMinor, formatSeconds } from "@/lib/money";

type VersionFieldName = keyof VersionFormValues;

interface VersionFormFieldsProps<T extends FieldValues> {
  form: UseFormReturn<T>;
  /** Nested key when the version lives inside a larger form (e.g. "version"). */
  prefix?: string;
  disabled?: boolean;
  /** Hide the change-summary textarea (version 1 of a brand-new offer has nothing to summarise). */
  hideChangeSummary?: boolean;
}

export function VersionFormFields<T extends FieldValues>({ form, prefix, disabled, hideChangeSummary }: VersionFormFieldsProps<T>) {
  const baseId = useId();
  const name = (field: VersionFieldName) => (prefix ? `${prefix}.${field}` : field) as Path<T>;
  const errorFor = (field: VersionFieldName): string | undefined => {
    const bag: FieldErrors<FieldValues> = prefix
      ? ((form.formState.errors as FieldErrors<FieldValues>)[prefix] as FieldErrors<FieldValues> | undefined) ?? {}
      : (form.formState.errors as FieldErrors<FieldValues>);
    const err = bag[field];
    return typeof err?.message === "string" ? err.message : undefined;
  };
  const register = (field: VersionFieldName) => form.register(name(field));

  const payoutType = form.watch(name("payout_type")) as VersionFormValues["payout_type"] | undefined;
  const currency = ((form.watch(name("currency")) as string | undefined) ?? "").toUpperCase() || "USD";
  const payoutTypeId = `${baseId}-payout-type`;
  const targetingId = `${baseId}-targeting`;
  const changeSummaryId = `${baseId}-change-summary`;

  const selectError = errorFor("payout_type");
  const targetingError = errorFor("targeting_lines");
  const changeSummaryError = errorFor("change_summary");

  return (
    <fieldset disabled={disabled} className="space-y-6 min-w-0">
      <legend className="sr-only">Version terms</legend>

      <section aria-labelledby={`${baseId}-economics`} className="space-y-4">
        <h3 id={`${baseId}-economics`} className="text-sm font-medium">
          Economics
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={payoutTypeId}>Payout type</Label>
            <select id={payoutTypeId} className={selectClassName} aria-invalid={selectError ? true : undefined} {...register("payout_type")}>
              {PAYOUT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PAYOUT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            {selectError ? (
              <p role="alert" className="text-xs text-destructive">
                {selectError}
              </p>
            ) : null}
          </div>
          <FormField label="Currency" placeholder="USD" maxLength={3} autoComplete="off" error={errorFor("currency")} {...register("currency")} />
          <FormField
            label={`Advertiser payout (${currency})`}
            inputMode="decimal"
            placeholder="40.00"
            description="What the advertiser pays per conversion. Confidential — never shown to affiliates."
            error={errorFor("advertiser_payout")}
            {...register("advertiser_payout")}
          />
          <FormField
            label={`Affiliate commission (${currency})`}
            inputMode="decimal"
            placeholder="30.00"
            description="What the affiliate earns per conversion. This is the figure shown in the marketplace."
            error={errorFor("affiliate_commission")}
            {...register("affiliate_commission")}
          />
          <FormField
            label={`Network margin (${currency}, optional)`}
            inputMode="decimal"
            description="Confidential. Left blank, the server derives it."
            error={errorFor("network_margin")}
            {...register("network_margin")}
          />
          <FormField
            label={payoutType === "REVSHARE" ? "Revenue share (%)" : "Revenue share (%, optional)"}
            inputMode="decimal"
            placeholder="25"
            error={errorFor("revshare_percent")}
            {...register("revshare_percent")}
          />
        </div>
      </section>

      <section aria-labelledby={`${baseId}-limits`} className="space-y-4">
        <h3 id={`${baseId}-limits`} className="text-sm font-medium">
          Caps, budget &amp; attribution
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Daily conversion cap (optional)" inputMode="numeric" error={errorFor("daily_conversion_cap")} {...register("daily_conversion_cap")} />
          <FormField label="Total conversion cap (optional)" inputMode="numeric" error={errorFor("total_conversion_cap")} {...register("total_conversion_cap")} />
          <FormField
            label={`Budget (${currency}, optional)`}
            inputMode="decimal"
            description="Confidential — never shown to affiliates."
            error={errorFor("budget")}
            {...register("budget")}
          />
          <FormField label="Attribution window (days)" inputMode="numeric" error={errorFor("attribution_window_days")} {...register("attribution_window_days")} />
          <FormField label="Conversion event" placeholder="purchase" autoComplete="off" error={errorFor("conversion_event")} {...register("conversion_event")} />
          <FormField
            label="Destination URL (optional)"
            type="url"
            placeholder="https://"
            autoComplete="off"
            error={errorFor("destination_url")}
            {...register("destination_url")}
          />
        </div>
      </section>

      <section aria-labelledby={`${baseId}-targeting`} className="space-y-4">
        <h3 id={`${baseId}-targeting`} className="text-sm font-medium">
          Targeting
        </h3>
        <div className="space-y-1.5">
          <Label htmlFor={targetingId}>Targeting rules (optional)</Label>
          <textarea
            id={targetingId}
            className={textareaClassName}
            rows={4}
            placeholder={"COUNTRY=US\nDEVICE=MOBILE"}
            aria-invalid={targetingError ? true : undefined}
            aria-describedby={`${targetingId}-description`}
            {...register("targeting_lines")}
          />
          <p id={`${targetingId}-description`} className="text-xs text-muted-foreground">
            One <code>DIMENSION=value</code> per line. Dimensions: {TARGETING_DIMENSIONS.join(", ")}. Values on the same dimension are an
            allow-list.
          </p>
          {targetingError ? (
            <p role="alert" className="text-xs text-destructive">
              {targetingError}
            </p>
          ) : null}
        </div>
      </section>

      {hideChangeSummary ? null : (
        <div className="space-y-1.5">
          <Label htmlFor={changeSummaryId}>Change summary (optional)</Label>
          <textarea
            id={changeSummaryId}
            className={textareaClassName}
            rows={2}
            aria-invalid={changeSummaryError ? true : undefined}
            {...register("change_summary")}
          />
          {changeSummaryError ? (
            <p role="alert" className="text-xs text-destructive">
              {changeSummaryError}
            </p>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}

/**
 * Owner-facing read-only rendering of one immutable version — includes the
 * confidential economics, so it must ONLY be mounted on advertiser pages.
 */
export function VersionDetails({ version }: { version: OfferVersion }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm" data-testid={`version-details-${version.version_number}`}>
      <DetailItem label="Version">v{version.version_number}</DetailItem>
      <DetailItem label="Created">
        <time dateTime={version.created_at}>{formatDateTime(version.created_at)}</time>
      </DetailItem>
      <DetailItem label="Payout type">{PAYOUT_TYPE_LABELS[version.payout_type] ?? version.payout_type}</DetailItem>
      <DetailItem label="Conversion event">{version.conversion_event}</DetailItem>
      <DetailItem label="Advertiser payout">{formatMinor(version.advertiser_payout_minor, version.currency)}</DetailItem>
      <DetailItem label="Affiliate commission">{formatMinor(version.affiliate_commission_minor, version.currency)}</DetailItem>
      <DetailItem label="Network margin">{formatMinor(version.network_margin_minor, version.currency)}</DetailItem>
      <DetailItem label="Revenue share">{version.revshare_percent_bps === null ? "—" : formatBps(version.revshare_percent_bps)}</DetailItem>
      <DetailItem label="Daily cap">{version.daily_conversion_cap ?? "—"}</DetailItem>
      <DetailItem label="Total cap">{version.total_conversion_cap ?? "—"}</DetailItem>
      <DetailItem label="Budget">{version.budget_minor === null ? "—" : formatMinor(version.budget_minor, version.currency)}</DetailItem>
      <DetailItem label="Attribution window">{formatSeconds(version.attribution_window_seconds)}</DetailItem>
      <DetailItem label="Destination URL">
        {version.destination_url ? <span className="font-mono break-all">{version.destination_url}</span> : "—"}
      </DetailItem>
      <DetailItem label="Targeting">
        {version.targeting.length === 0 ? (
          "None"
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {version.targeting.map((t) => (
              <li key={`${t.dimension}=${t.value}`} className="rounded-full border px-2 py-0.5 text-xs">
                {TARGETING_DIMENSION_LABELS[t.dimension] ?? t.dimension}: {t.value}
              </li>
            ))}
          </ul>
        )}
      </DetailItem>
      {version.change_summary ? (
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Change summary</dt>
          <dd className="whitespace-pre-wrap">{version.change_summary}</dd>
        </div>
      ) : null}
    </dl>
  );
}
