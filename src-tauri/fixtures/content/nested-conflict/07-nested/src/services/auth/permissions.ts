export type Role = "admin" | "editor" | "viewer";

export interface Permission {
  resource: string;
  actions: ("read" | "write" | "delete")[];
}

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    { resource: "*", actions: ["read", "write", "delete"] },
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
