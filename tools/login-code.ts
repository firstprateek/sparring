// Prints a one-time login code for a new device: it works once and lapses in ten minutes. Run on the machine
// that runs the daemon: `pnpm login-code`.
import { sparringHome } from "../apps/daemon/src/config.ts";
import { CODE_TTL_MS, mintCode } from "../apps/daemon/src/login-codes.ts";

console.log(`${mintCode(sparringHome())}  (one use, ${CODE_TTL_MS / 60_000} minutes)`);
