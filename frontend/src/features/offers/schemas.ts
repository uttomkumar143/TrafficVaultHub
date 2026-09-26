/**
 * Client-side validation mirroring `backend/src/routes/offers.ts`. Immediate
 * feedback only — the server re-validates every request (PRD §5).
 *
 * Money fields are typed by the user in MAJOR units as strings (e.g. "40.00")
 * and converted to integer minor units with `parseMajorToMinor` (string
 * arithmetic, no floats). The payload that leaves the browser is always
 * `*_minor: integer` + `currency` (PRD §25).
 */
import { z } from "zod";
import { parseMajorToMinor } from "@/lib/money";
import { ACCESS_MODES, PAYOUT_TYPES, TARGETING_DIMENSIONS, type Targeting } from "@/types/api";
import type { CreateOfferInput, OfferVersionInput } from "@/features/offers/api";

const optionalTrimmed = (max: number, label: string) =>
  z.string().trim().max(max, `${label} is too long`).optional().or(z.literal(""));

export const currencyField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Use a 3-letter currency code (e.g. USD)");

/** Major-unit string; emptiness handled per field (required vs optional). */
const moneyString = z.string().trim();

/** Positive-integer-or-empty string for caps / windows. */
const optionalIntegerString = z
  .string()
  .trim()
  .regex(/^$|^\d{1,15}$/, "Enter a whole number");

export const versionFormSchema = z
  .object({
    payout_type: z.enum(PAYOUT_TYPES, { message: "Choose a payout type" }),
    currency: currencyField,
    advertiser_payout: moneyString.min(1, "Advertiser payout is required"),
    affiliate_commission: moneyString.min(1, "Affiliate commission is required"),
    network_margin: moneyString,
    revshare_percent: z
      .string()
      .trim()
      .regex(/^$|^\d{1,3}(?:\.\d{1,2})?$/, "Enter a percentage like 25 or 12.5"),
    daily_conversion_cap: optionalIntegerString,
    total_conversion_cap: optionalIntegerString,
    budget: moneyString,
    attribution_window_days: z.string().trim().regex(/^$|^\d{1,5}$/, "Enter whole days"),
    conversion_event: z.string().trim().min(1, "Conversion event is required").max(120, "Too long"),
    destination_url: z
      .string()
      .trim()
      .max(2048, "URL is too long")
      .refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), "Enter a valid http(s) URL"),
    change_summary: optionalTrimmed(2000, "Change summary"),
    /** One `DIMENSION=value` per line; parsed by `parseTargetingLines`. */
    targeting_lines: z.string().max(20_000, "Too many targeting rules"),
  })
  .superRefine((values, ctx) => {
    const cur = values.currency.toUpperCase();
    const check = (field: "advertiser_payout" | "affiliate_commission" | "network_margin" | "budget", required: boolean) => {
      const raw = values[field];
      if (raw === "") {
        if (required) ctx.addIssue({ code: "custom", path: [field], message: "Required" });
        return null;
      }
      const minor = parseMajorToMinor(raw, cur);
      if (minor === null) {
        ctx.addIssue({ code: "custom", path: [field], message: `Enter an amount with at most the ${cur} minor-unit precision` });
      }
      return minor;
    };
    const payout = check("advertiser_payout", true);
    const commission = check("affiliate_commission", true);
    check("network_margin", false);
    check("budget", false);
    if (payout !== null && commission !== null && commission > payout) {
      ctx.addIssue({ code: "custom", path: ["affiliate_commission"], message: "Commission cannot exceed the advertiser payout" });
    }
    if (values.payout_type === "REVSHARE" && values.revshare_percent === "") {
      ctx.addIssue({ code: "custom", path: ["revshare_percent"], message: "REVSHARE requires a percentage" });
    }
    if (values.revshare_percent !== "") {
      const bps = percentToBps(values.revshare_percent);
      if (bps === null || bps < 1 || bps > 10_000) {
        ctx.addIssue({ code: "custom", path: ["revshare_percent"], message: "Percentage must be between 0.01 and 100" });
      }
    }
    const targeting = parseTargetingLines(values.targeting_lines);
    if (targeting.error) ctx.addIssue({ code: "custom", path: ["targeting_lines"], message: targeting.error });
  });
export type VersionFormValues = z.infer<typeof versionFormSchema>;

export const createOfferFormSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(200, "Name is too long"),
  vertical: optionalTrimmed(120, "Vertical"),
  description: optionalTrimmed(4000, "Description"),
  access_mode: z.enum(ACCESS_MODES, { message: "Choose an access mode" }),
});
export type CreateOfferFormValues = z.infer<typeof createOfferFormSchema>;

/** "25" → 2500, "12.5" → 1250 — string math only. */
export function percentToBps(percent: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(percent.trim());
  if (!m) return null;
  return Number((m[1] ?? "0") + (m[2] ?? "").padEnd(2, "0"));
}

export function parseTargetingLines(text: string): { rules: Targeting[]; error: string | null } {
  const rules: Targeting[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { rules, error: `"${line}" — use DIMENSION=value (e.g. COUNTRY=US)` };
    const dimension = line.slice(0, eq).trim().toUpperCase();
    const value = line.slice(eq + 1).trim();
    if (!(TARGETING_DIMENSIONS as readonly string[]).includes(dimension)) {
      return { rules, error: `Unknown dimension "${dimension}". Use one of ${TARGETING_DIMENSIONS.join(", ")}` };
    }
    if (!value || value.length > 200) return { rules, error: `"${line}" — value must be 1–200 characters` };
    const key = `${dimension}=${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ dimension: dimension as Targeting["dimension"], value });
    if (rules.length > 500) return { rules, error: "At most 500 targeting rules" };
  }
  return { rules, error: null };
}

export const DEFAULT_VERSION_FORM: VersionFormValues = {
  payout_type: "CPA",
  currency: "USD",
  advertiser_payout: "",
  affiliate_commission: "",
  network_margin: "",
  revshare_percent: "",
  daily_conversion_cap: "",
  total_conversion_cap: "",
  budget: "",
  attribution_window_days: "30",
  conversion_event: "",
  destination_url: "",
  change_summary: "",
  targeting_lines: "",
};

/**
 * Convert validated form values into the wire payload. All money fields are
 * integer minor units; every optional empty string becomes an omitted key.
 * Only call after `versionFormSchema` has accepted the values.
 */
export function toVersionPayload(values: VersionFormValues): OfferVersionInput & { targeting?: Targeting[] } {
  const currency = values.currency.toUpperCase();
  const money = (s: string) => parseMajorToMinor(s, currency);
  const intOrNull = (s: string) => (s === "" ? null : Number(s));
  const payload: OfferVersionInput & { targeting?: Targeting[] } = {
    payout_type: values.payout_type,
    currency,
    advertiser_payout_minor: money(values.advertiser_payout) ?? 0,
    affiliate_commission_minor: money(values.affiliate_commission) ?? 0,
    conversion_event: values.conversion_event,
  };
  if (values.network_margin !== "") payload.network_margin_minor = money(values.network_margin) ?? 0;
  if (values.revshare_percent !== "") payload.revshare_percent_bps = percentToBps(values.revshare_percent);
  payload.daily_conversion_cap = intOrNull(values.daily_conversion_cap);
  payload.total_conversion_cap = intOrNull(values.total_conversion_cap);
  if (values.budget !== "") payload.budget_minor = money(values.budget);
  if (values.attribution_window_days !== "") {
    payload.attribution_window_seconds = Number(values.attribution_window_days) * 86_400;
  }
  payload.destination_url = values.destination_url === "" ? null : values.destination_url;
  if (values.change_summary) payload.change_summary = values.change_summary;
  const targeting = parseTargetingLines(values.targeting_lines).rules;
  if (targeting.length > 0) payload.targeting = targeting;
  return payload;
}

export function toCreatePayload(offer: CreateOfferFormValues, version: VersionFormValues): CreateOfferInput {
  const { targeting, ...v } = toVersionPayload(version);
  const payload: CreateOfferInput = {
    name: offer.name,
    access_mode: offer.access_mode,
    version: v,
  };
  if (offer.vertical) payload.vertical = offer.vertical;
  if (offer.description) payload.description = offer.description;
  if (targeting) payload.targeting = targeting;
  return payload;
}
