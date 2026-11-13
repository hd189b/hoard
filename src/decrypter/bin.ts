// Entry point for the standalone executable.
import { WrongPasswordError } from "../core/keys";
import { main } from "./cli";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    process.exit(e instanceof WrongPasswordError ? 2 : 1);
  },
);
