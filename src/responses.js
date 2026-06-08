export function corsHeaders(env = {}) {
  const origin = env.CORS_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Wallet-Address,X-Signature,X-Signed-Message",
    "Access-Control-Max-Age": "86400"
  };
}

export function json(data, init = {}, env = {}) {
  const responseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(responseInit.headers || {});
  for (const [key, value] of Object.entries(corsHeaders(env))) {
    headers.set(key, value);
  }
  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(data, null, 2), {
    ...responseInit,
    headers
  });
}

export function errorJson(status, code, message, details = undefined, env = {}) {
  return json(
    {
      ok: false,
      error: {
        code,
        message,
        details
      }
    },
    { status },
    env
  );
}

