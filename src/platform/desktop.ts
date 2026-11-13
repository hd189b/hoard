// Everything that needs Node / Electron. Loaded only on desktop (Windows, Linux),
// so the Android build never touches these modules.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export { makeNodeHttp } from "./http-node";
export { CliTransport, generateSshKey } from "./git-cli";
export { createKWallet, detectLinuxBackends, kwalletWallets, linuxStore, pickDefault, LINUX_BACKEND_LABEL, LINUX_BACKEND_ORDER } from "./secrets-linux";
export type { LinuxBackend } from "./secrets-linux";

export const nodeFs = fs;
export const joinPath = (...p: string[]) => path.join(...p);
export const platform = () => os.platform();
