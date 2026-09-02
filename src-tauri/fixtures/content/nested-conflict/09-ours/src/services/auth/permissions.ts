export type Role = "owner" | "admin" | "editor" | "viewer";

export type Action = "read" | "write" | "delete" | "admin";

export interface Permission {
  resource: string;
  actions: Action[];
  conditions?: Record<string, unknown>;
}

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [
    { resource: "*", actions: ["read", "write", "delete", "admin"] },
  ],
  admin: [
    { resource: "*", actions: ["read", "write", "delete"] },
    { resource: "settings", actions: ["read", "write"] },
  ],
  editor: [
    { resource: "posts", actions: ["read", "write"] },
    { resource: "comments", actions: ["read", "write", "delete"] },
    { resource: "media", actions: ["read", "write"] },
  ],
  viewer: [
    { resource: "posts", actions: ["read"] },
    { resource: "comments", actions: ["read"] },
    { resource: "media", actions: ["read"] },
  ],
};

export function getPermissions(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function hasPermission(
  role: Role,
  resource: string,
  action: "read" | "write" | "delete",
): boolean {
  const permissions = getPermissions(role);
  return permissions.some(
    (p) =>
      (p.resource === "*" || p.resource === resource) &&
      p.actions.includes(action),
  );
}
