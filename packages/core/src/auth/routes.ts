import type { Permission } from "./rbac.js";

/**
 * Descriptor de ruta.
 *
 * `chatSafe` es la pieza central del modelo: una clave limitada a chats solo
 * puede llamar rutas marcadas como seguras para ella. Todo lo demás —incluidas
 * las rutas que se añadan en versiones futuras— se rechaza. La negativa es el
 * DEFECTO, no una lista negra que alguien tiene que acordarse de mantener.
 */
export interface RouteDescriptor {
  readonly id: string;
  readonly permission: Permission;
  /** Qué ámbito toca: decide si hay que comprobar línea y chat. */
  readonly scope: "org" | "line" | "chat";
  /** Alcanzable por una clave limitada a chats, dentro de los suyos. */
  readonly chatSafe?: boolean;
}

/**
 * Catálogo de rutas. Vive en el dominio y no en la capa HTTP para que el
 * servidor MCP, el WebSocket y el panel apliquen exactamente las mismas reglas:
 * OpenWA documenta que cada superficie fuera del guard REST necesita su propia
 * comprobación, y tener una sola fuente evita que una se quede atrás.
 */
export const ROUTES = {
  // --- organización
  "org.read": { id: "org.read", permission: "line.read", scope: "org" },
  "org.members.list": { id: "org.members.list", permission: "org.members.manage", scope: "org" },
  "org.members.update": { id: "org.members.update", permission: "org.members.manage", scope: "org" },
  "org.audit.list": { id: "org.audit.list", permission: "org.audit.read", scope: "org" },
  "apikey.list": { id: "apikey.list", permission: "apikey.manage", scope: "org" },
  "apikey.create": { id: "apikey.create", permission: "apikey.manage", scope: "org" },
  "apikey.revoke": { id: "apikey.revoke", permission: "apikey.manage", scope: "org" },
  "plugin.manage": { id: "plugin.manage", permission: "plugin.manage", scope: "org" },

  // --- líneas
  "line.list": { id: "line.list", permission: "line.read", scope: "org" },
  "line.create": { id: "line.create", permission: "line.create", scope: "org" },
  "line.delete": { id: "line.delete", permission: "line.delete", scope: "line" },
  "line.connect": { id: "line.connect", permission: "line.connect", scope: "line" },
  "line.settings": { id: "line.settings", permission: "line.settings", scope: "line" },
  // Una integración necesita saber si su línea está viva, aunque no vea los chats.
  "line.status": { id: "line.status", permission: "line.read", scope: "line", chatSafe: true },
  "webhook.manage": { id: "webhook.manage", permission: "webhook.manage", scope: "line" },

  // --- chats y mensajes
  "chat.list": { id: "chat.list", permission: "message.read", scope: "line", chatSafe: true },
  "chat.read": { id: "chat.read", permission: "message.read", scope: "chat", chatSafe: true },
  "chat.markRead": { id: "chat.markRead", permission: "chat.manage", scope: "chat", chatSafe: true },
  "chat.archive": { id: "chat.archive", permission: "chat.manage", scope: "chat", chatSafe: true },
  "chat.clear": { id: "chat.clear", permission: "chat.manage", scope: "chat", chatSafe: true },
  "chat.presence": { id: "chat.presence", permission: "message.send", scope: "chat", chatSafe: true },
  "message.list": { id: "message.list", permission: "message.read", scope: "chat", chatSafe: true },
  "message.send": { id: "message.send", permission: "message.send", scope: "chat", chatSafe: true },
  "message.edit": { id: "message.edit", permission: "message.send", scope: "chat", chatSafe: true },
  "message.delete": { id: "message.delete", permission: "message.delete", scope: "chat", chatSafe: true },
  "message.react": { id: "message.react", permission: "message.send", scope: "chat", chatSafe: true },

  // --- grupos
  // Leer, renombrar y salir sí; decidir QUIÉN pertenece al grupo, no. Un agente
  // acotado a un grupo no puede meter ni echar a nadie de él.
  "group.read": { id: "group.read", permission: "group.read", scope: "chat", chatSafe: true },
  "group.update": { id: "group.update", permission: "group.manage", scope: "chat", chatSafe: true },
  "group.leave": { id: "group.leave", permission: "group.manage", scope: "chat", chatSafe: true },
  "group.create": { id: "group.create", permission: "group.manage", scope: "line" },
  "group.participants": { id: "group.participants", permission: "group.manage", scope: "chat" },
  "group.invite": { id: "group.invite", permission: "group.manage", scope: "chat" },

  // --- contactos
  "contact.list": { id: "contact.list", permission: "contact.read", scope: "line" },
  "contact.block": { id: "contact.block", permission: "contact.manage", scope: "chat", chatSafe: true },
  "contact.check": { id: "contact.check", permission: "contact.read", scope: "line" },
} as const satisfies Record<string, RouteDescriptor>;

export type RouteId = keyof typeof ROUTES;
export const route = (id: RouteId): RouteDescriptor => ROUTES[id];
