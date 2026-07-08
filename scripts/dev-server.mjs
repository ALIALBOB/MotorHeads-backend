import http from "node:http";
import worker from "../src/index.js";

const port = Number(process.env.PORT || 8787);
const env = {
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
  ALLOW_UNVERIFIED_WRITES: process.env.ALLOW_UNVERIFIED_WRITES || "false",
  ETH_RPC_URL: process.env.ETH_RPC_URL || "",
  MOTORHEADS_DEPLOY_BLOCK: process.env.MOTORHEADS_DEPLOY_BLOCK || "0",
  INDEXER_ADMIN_TOKEN: process.env.INDEXER_ADMIN_TOKEN || "",
  INDEXER_CONFIRMATIONS: process.env.INDEXER_CONFIRMATIONS || "6",
  INDEXER_MAX_BLOCK_RANGE: process.env.INDEXER_MAX_BLOCK_RANGE || "1000",
  INDEXER_MAX_LOGS_PER_RUN: process.env.INDEXER_MAX_LOGS_PER_RUN || "50",
  GAS_LOW_GWEI: process.env.GAS_LOW_GWEI || "15",
  GAS_MEDIUM_GWEI: process.env.GAS_MEDIUM_GWEI || "45",
  GAS_HIGH_GWEI: process.env.GAS_HIGH_GWEI || "90",
  EMERGENCY_READ_ONLY: process.env.EMERGENCY_READ_ONLY || "false",
  EMERGENCY_BLOCK_PUBLIC_READS: process.env.EMERGENCY_BLOCK_PUBLIC_READS || "false",
  INDEXER_ENABLED: process.env.INDEXER_ENABLED || "true",
  SAFETY_MAX_INDEXER_RUNS_PER_DAY: process.env.SAFETY_MAX_INDEXER_RUNS_PER_DAY || "320",
  SAFETY_MAX_RPC_CALLS_PER_DAY: process.env.SAFETY_MAX_RPC_CALLS_PER_DAY || "5000",
  SAFETY_MAX_REGISTRY_WRITES_PER_DAY: process.env.SAFETY_MAX_REGISTRY_WRITES_PER_DAY || "1000"
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
