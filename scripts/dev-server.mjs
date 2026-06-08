import http from "node:http";
import worker from "../src/index.js";

const port = Number(process.env.PORT || 8787);
const env = {
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
  ALLOW_UNVERIFIED_WRITES: process.env.ALLOW_UNVERIFIED_WRITES || "false"
};

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else if (value !== undefined) {
        headers.set(key, value);
      }
    }

    const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method,
      headers,
      body: body && body.length ? body : undefined
    });

    const response = await worker.fetch(request, env, {});
    const responseHeaders = Object.fromEntries(response.headers.entries());
    res.writeHead(response.status, responseHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: { code: "dev_server_error", message: error.message } }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MotorHeads backend dev server running at http://127.0.0.1:${port}`);
});
