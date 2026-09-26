import { createDatabase, orgMemberTable, userTable } from "@omni/db";
import { hashPassword } from "@omni/core";

const url = process.env["DATABASE_URL"]!;
const { db, close } = createDatabase(url);
const email = "ada@ejemplo.com";
const password = "una contraseña larga de prueba";

await db.insert(userTable).values({
  id: "u-demo", email, name: "Ada", emailVerified: true,
  passwordHash: await hashPassword(password),
}).onConflictDoNothing();
await db.insert(orgMemberTable).values({
  orgId: "org-demo", userId: "u-demo", role: "owner",
}).onConflictDoNothing();
console.log(JSON.stringify({ email, password }));
await close();
