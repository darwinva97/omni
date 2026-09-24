export type Role = "owner" | "manager" | "agent" | "viewer";

/**
 * Permisos por rol. Un solo triplete —más `viewer`— sirve para la organización
 * y para cada línea, en vez de dos jerarquías que hay que mantener en paralelo.
 */
export const permissions = [
  "org.manage", "org.members.manage", "org.audit.read", "org.billing.manage",
  "line.create", "line.delete", "line.connect", "line.read", "line.settings",
  "line.share",
  "message.read", "message.send", "message.delete",
  "chat.manage",
  "group.read", "group.manage",
  "contact.read", "contact.manage",
  "connector.manage", "apikey.manage", "webhook.manage",
  "plugin.manage", "automation.read", "automation.manage",
] as const;
export type Permission = (typeof permissions)[number];

const VIEWER: Permission[] = ["line.read", "message.read", "group.read", "contact.read", "automation.read"];
const AGENT: Permission[] = [...VIEWER, "message.send", "chat.manage"];
const MANAGER: Permission[] = [
  ...AGENT, "line.create", "line.connect", "line.settings", "line.share",
  "message.delete", "group.manage", "contact.manage",
  "connector.manage", "apikey.manage", "webhook.manage", "automation.manage",
];
const OWNER: Permission[] = [
  ...MANAGER, "org.manage", "org.members.manage", "org.audit.read",
  "org.billing.manage", "line.delete", "plugin.manage",
];

const BY_ROLE: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  agent: new Set(AGENT),
  manager: new Set(MANAGER),
  owner: new Set(OWNER),
};

export const roleHas = (role: Role, p: Permission): boolean => BY_ROLE[role].has(p);

const RANK: Record<Role, number> = { viewer: 0, agent: 1, manager: 2, owner: 3 };

/** Nadie puede otorgar un rol por encima del suyo. */
export const canGrantRole = (actor: Role, target: Role): boolean => RANK[target] <= RANK[actor];

/** Permisos de una clave de API, derivados de su papel. */
const KEY_ROLE: Record<"admin" | "operator" | "viewer", ReadonlySet<Permission>> = {
  admin: new Set(OWNER),
  operator: new Set(MANAGER),
  viewer: new Set(VIEWER),
};

export const keyRoleHas = (role: "admin" | "operator" | "viewer", p: Permission): boolean =>
  KEY_ROLE[role].has(p);
