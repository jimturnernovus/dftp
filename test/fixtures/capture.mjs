// A loopback server that stands in for "somewhere else": it counts every
// connection and request that reaches it. Proxy tests point redirects and
// cross-site pages at it and then check it saw nothing it should not have.
// It can also serve one fixed HTML page (for browser tests that need a page
// on another origin).

import http from "node:http";

export async function startCapture({ pageHtml = null, csp = null } = {}) {
  const requests = [];
  let connections = 0;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    req.resume();
    if (pageHtml && req.url === "/") {
      const body = Buffer.from(pageHtml);
      const headers = { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" };
      if (csp) headers["Content-Security-Policy"] = csp;
      res.writeHead(200, headers);
      res.end(body);
      return;
    }
    res.writeHead(404, { "Content-Length": 0 });
    res.end();
  });
  server.on("connection", (s) => {
    connections++;
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.on("upgrade", (req, socket) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, upgrade: true });
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    connections: () => connections,
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
