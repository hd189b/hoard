// Entry point for the standalone executable.
import { WrongPasswordError } from "../core/keys";
import { main } from "./cli";

// Set the exit code and let Node finish writing output (process.exit() would cut
// off data still on its way into a pipe, e.g. `encgidian-decrypt cat … | other`).
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    process.exitCode = e instanceof WrongPasswordError ? 2 : 1;
  },
);
