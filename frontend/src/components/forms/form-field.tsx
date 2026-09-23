import { useId, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

export interface FormFieldProps extends Omit<ComponentProps<typeof Input>, "id"> {
  label: string;
  /** Validation message; when present the input is marked `aria-invalid`. */
  error?: string;
  description?: ReactNode;
  id?: string;
}

/**
 * Accessible labelled input: label ↔ input via `htmlFor`, error text linked
 * with `aria-describedby`, `aria-invalid` when in error.
 */
export function FormField({ label, error, description, id, className, ...inputProps }: FormFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const descId = `${inputId}-description`;
  const describedBy = [error ? errorId : null, description ? descId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={inputId}>{label}</Label>
      <Input id={inputId} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...inputProps} />
      {description ? (
        <p id={descId} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
