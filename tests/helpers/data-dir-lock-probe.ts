// Run as its own process: whether it can take the data directory's lock.
import { lockDataDir } from "../../src/server/platform/fs/data-dir-lock.js";

const lock = await lockDataDir(process.argv[2]!, { waitMs: 0 });
console.log(lock ? "GOT" : "REFUSED");
