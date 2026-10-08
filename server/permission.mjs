// Node's permission model, used as an extra fence when this Node supports
// it: the server may read only the tool folder and the project and write only
// the project's .dftp folder. It may not start other programs at all: with
// --open, the command outside the fence opens the browser. Code generation
// from strings is switched off as well.

import path from "node:path";
import { DATA_DIR } from "./store.mjs";

export function permissionSupported() {
  return process.allowedNodeEnvironmentFlags.has("--permission");
}

// Newer Node versions also fence the network; the listeners (and the proxy
// to the loopback dev server) need it, so it is allowed where that flag exists.
export function netFlagSupported() {
  return process.allowedNodeEnvironmentFlags.has("--allow-net");
}

export function permissionArgs({ toolDir, root, net = netFlagSupported() }) {
  return [
    "--permission",
    `--allow-fs-read=${toolDir}`,
    `--allow-fs-read=${root}`,
    `--allow-fs-write=${path.join(root, DATA_DIR)}`,
    ...(net ? ["--allow-net"] : []),
    "--disallow-code-generation-from-strings",
  ];
}
