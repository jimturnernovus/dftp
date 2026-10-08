// Opens the designer in the default browser. The command is run directly
// (never through a shell) and only for a loopback http address.

import { execFile } from "node:child_process";

// The designer address, optionally with its one-time sign-in key.
const URL_RE = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}\/(\?k=[0-9a-f]{16,128})?$/;

export function openCommand(url, platform = process.platform) {
  if (!URL_RE.test(url)) return null;
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { cmd: "xdg-open", args: [url] };
}

export function openBrowser(url, onError = () => {}) {
  const c = openCommand(url);
  if (!c) {
    onError();
    return false;
  }
  try {
    const child = execFile(c.cmd, c.args, { windowsHide: true, timeout: 15000 }, (err) => {
      if (err) onError();
    });
    child.unref();
    return true;
  } catch {
    onError();
    return false;
  }
}
