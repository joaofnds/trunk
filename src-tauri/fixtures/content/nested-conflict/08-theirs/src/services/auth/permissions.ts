export type Role = "admin" | "moderator" | "editor" | "viewer" | "guest";

export type Action = "read" | "write" | "delete" | "publish" | "moderate";

export interface Permission {
  resource: string;
  actions: Action[];
}

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    { resource: "*", actions: ["read", "write", "delete", "publish", "moderate"] },
  ],
  moderator: [
    { resource: "posts", actions: ["read", "write", "moderate"] },
    { resource: "comments", actions: ["read", "write", "delete", "moderate"] },
    { resource: "media", actions: ["read", "write", "delete"] },
    { resource: "users", actions: ["read"] },
  ],
  editor: [
    { resource: "posts", actions: ["read", "write", "publish"] },
    { resource: "comments", actions: ["read", "write", "delete"] },
    { resource: "media", actions: ["read", "write"] },
  ],
  viewer: [
    { resource: "posts", actions: ["read"] },
    { resource: "comments", actions: ["read"] },
    { resource: "media", actions: ["read"] },
  ],
  guest: [
    { resource: "posts", actions: ["read"] },
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
