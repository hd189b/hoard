// isomorphic-git uses Buffer. Desktop has Node's; Android gets the polyfill.
import { Buffer as BufferPolyfill } from "buffer";
export const Buffer = globalThis.Buffer ?? BufferPolyfill;
