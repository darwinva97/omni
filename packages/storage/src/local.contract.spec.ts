import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStorageContract } from "./contract/suite.js";
import { LocalStorage } from "./local.js";

runStorageContract("disco local", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omni-storage-"));
  return new LocalStorage({ directory: dir, signingSecret: "secreto-de-firma-largo" });
});
