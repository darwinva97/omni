import { runJobQueueContract, runKvContract } from "../contract/queue-suite.js";
import { MemoryJobQueue } from "./queue.js";
import { MemoryKv } from "./kv.js";

runJobQueueContract("memoria", async () => new MemoryJobQueue());
runKvContract("memoria", async () => new MemoryKv());
