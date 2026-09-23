import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useParams } from "react-router";
import { FormField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/features/auth/use-auth";
import { useMemberMutations, useMembers, useRoles, useTenant } from "@/features/organizations/hooks";
import { addMemberSchema, type AddMemberFormValues } from "@/features/organizations/schemas";
import { NotAMember } from "@/routes/app/organization-overview-page";
import { errorMessage } from "@/lib/error-message";
import type { PublicMember, PublicRole } from "@/types/api";

/**
 * `/app/:orgId/members` — member list (`members.read`) with add / change role /
 * remove actions shown only when the caller holds `members.manage`
 * (`GET /organizations/:orgId/me`). The server re-checks every action and
 * enforces the owner-seat, LAST_OWNER and SELF_MODIFICATION rules; this page
 * merely surfaces its answers.
 */
export function MembersPage() {
  const { orgId = "" } = useParams<{ orgId: string }>();
  const auth = useAuth();
  const tenant = useTenant(orgId);
  const canManage = tenant.can("members.manage");
  const members = useMembers(orgId);
  const roles = useRoles(orgId, canManage);
  const mutations = useMemberMutations(orgId);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const run = async (op: Promise<unknown>) => {
    setActionError(null);
    try {
      await op;
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <section id="members-section" className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="text-sm text-muted-foreground">{tenant.tenant?.organization.name}</p>
      </header>

      {actionError ? (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {members.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading members…
        </p>
      ) : members.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(members.error)}</AlertDescription>
        </Alert>
      ) : members.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No members.</p>
      ) : (
        <table className="w-full text-sm border rounded-lg overflow-hidden">
          <caption className="sr-only">Organization members</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Member
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Role
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              {canManage ? (
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {members.data.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                isSelf={m.user.id === auth.user?.id}
                canManage={canManage}
                roles={roles.data ?? []}
                busy={mutations.changeRole.isPending || mutations.remove.isPending}
                onChangeRole={(role) => run(mutations.changeRole.mutateAsync({ memberId: m.id, role }))}
                onRemove={() => run(mutations.remove.mutateAsync({ id: m.id }))}
              />
            ))}
          </tbody>
        </table>
      )}

      {canManage ? (
        <AddMemberForm
          roles={roles.data ?? []}
          rolesError={roles.isError ? errorMessage(roles.error) : null}
          busy={mutations.add.isPending}
          onSubmit={(values) => run(mutations.add.mutateAsync(values))}
        />
      ) : null}
    </section>
  );
}

interface MemberRowProps {
  member: PublicMember;
  isSelf: boolean;
  canManage: boolean;
  roles: PublicRole[];
  busy: boolean;
  onChangeRole: (role: string) => void;
  onRemove: () => void;
}

function MemberRow({ member, isSelf, canManage, roles, busy, onChangeRole, onRemove }: MemberRowProps) {
  const label = member.user.display_name ? `${member.user.display_name} (${member.user.email})` : member.user.email;
  const selectId = `member-role-${member.id}`;
  return (
    <tr className="border-t">
      <td className="px-3 py-2">
        {label}
        {isSelf ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
      </td>
      <td className="px-3 py-2">
        {canManage && !isSelf ? (
          <>
            <label htmlFor={selectId} className="sr-only">
              Role for {member.user.email}
            </label>
            <select
              id={selectId}
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={member.role.key}
              disabled={busy}
              onChange={(e) => onChangeRole(e.target.value)}
            >
              {roles.some((r) => r.key === member.role.key) ? null : (
                <option value={member.role.key}>{member.role.name}</option>
              )}
              {roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
          </>
        ) : (
          member.role.name
        )}
      </td>
      <td className="px-3 py-2">{member.status}</td>
      {canManage ? (
        <td className="px-3 py-2 text-right">
          {!isSelf ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Remove ${member.user.email}`}
              onClick={() => {
                if (window.confirm(`Remove ${member.user.email} from this organization?`)) onRemove();
              }}
            >
              Remove
            </Button>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}

interface AddMemberFormProps {
  roles: PublicRole[];
  rolesError: string | null;
  busy: boolean;
  onSubmit: (values: AddMemberFormValues) => Promise<void>;
}

function AddMemberForm({ roles, rolesError, busy, onSubmit }: AddMemberFormProps) {
  const form = useForm<AddMemberFormValues>({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { email: "", role: "" },
  });
  const errors = form.formState.errors;
  const roleId = "add-member-role";

  const submit = form.handleSubmit(async (values) => {
    await onSubmit(values);
    form.reset({ email: "", role: values.role });
  });

  return (
    <form id="add-member-form" onSubmit={submit} noValidate className="space-y-4 rounded-lg border bg-card p-4">
      <h2 className="text-sm font-medium">Add member</h2>
      <p className="text-xs text-muted-foreground">The person must already have a verified TrafficVaultHub account.</p>
      {rolesError ? (
        <Alert variant="destructive">
          <AlertDescription>{rolesError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Email" type="email" autoComplete="off" error={errors.email?.message} {...form.register("email")} />
        <div className="space-y-1.5">
          <Label htmlFor={roleId}>Role</Label>
          <select
            id={roleId}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            aria-invalid={errors.role ? true : undefined}
            {...form.register("role")}
          >
            <option value="">Select role</option>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
          {errors.role ? (
            <p role="alert" className="text-xs text-destructive">
              {errors.role.message}
            </p>
          ) : null}
        </div>
      </div>
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? "Adding…" : "Add member"}
      </Button>
    </form>
  );
}
