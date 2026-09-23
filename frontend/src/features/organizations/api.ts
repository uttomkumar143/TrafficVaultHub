/**
 * Organizations API bindings — one function per `/api/v1/organizations*`
 * endpoint (`backend/src/routes/organizations.ts`). Thin wrappers over
 * `apiRequest`. The acting organization is always the path parameter; no
 * `organization_id` is ever sent in a body (PRD §94 — the server ignores it
 * anyway).
 */
import { apiRequest } from "@/lib/api";
import type {
  PublicMember,
  PublicOrganization,
  PublicRole,
  SelfServiceOrgType,
  TenantMeResponse,
} from "@/types/api";

export interface CreateOrganizationInput {
  type: SelfServiceOrgType;
  name: string;
  slug?: string;
}

export interface AddMemberInput {
  email: string;
  role: string;
}

const org = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}`;
const member = (orgId: string, memberId: string) => `${org(orgId)}/members/${encodeURIComponent(memberId)}`;

export function listOrganizations(signal?: AbortSignal): Promise<{ organizations: PublicOrganization[] }> {
  return apiRequest<{ organizations: PublicOrganization[] }>("/organizations", { signal });
}

export function createOrganization(input: CreateOrganizationInput): Promise<{ organization: PublicOrganization }> {
  return apiRequest<{ organization: PublicOrganization }>("/organizations", { method: "POST", body: input });
}

export function getOrganization(orgId: string, signal?: AbortSignal): Promise<{ organization: PublicOrganization }> {
  return apiRequest<{ organization: PublicOrganization }>(org(orgId), { signal });
}

export function updateOrganization(orgId: string, input: { name: string }): Promise<{ organization: PublicOrganization }> {
  return apiRequest<{ organization: PublicOrganization }>(org(orgId), { method: "PATCH", body: input });
}

/** The caller's authority inside the organization — UI gating only (PRD §5). */
export function getTenantMe(orgId: string, signal?: AbortSignal): Promise<TenantMeResponse> {
  return apiRequest<TenantMeResponse>(`${org(orgId)}/me`, { signal });
}

export function listRoles(orgId: string, signal?: AbortSignal): Promise<{ roles: PublicRole[] }> {
  return apiRequest<{ roles: PublicRole[] }>(`${org(orgId)}/roles`, { signal });
}

export function listMembers(orgId: string, signal?: AbortSignal): Promise<{ members: PublicMember[] }> {
  return apiRequest<{ members: PublicMember[] }>(`${org(orgId)}/members`, { signal });
}

export function addMember(orgId: string, input: AddMemberInput): Promise<{ member: PublicMember }> {
  return apiRequest<{ member: PublicMember }>(`${org(orgId)}/members`, { method: "POST", body: input });
}

export function changeMemberRole(orgId: string, memberId: string, role: string): Promise<{ member: PublicMember }> {
  return apiRequest<{ member: PublicMember }>(member(orgId, memberId), { method: "PATCH", body: { role } });
}

export function removeMember(orgId: string, memberId: string): Promise<void> {
  return apiRequest<void>(member(orgId, memberId), { method: "DELETE" });
}
