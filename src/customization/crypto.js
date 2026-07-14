const encoder = new TextEncoder();

export function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function clientIpPrefix(request) {
  const raw = String(
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0] ||
    "unknown"
  ).trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return raw.split(".").slice(0, 3).join(".") + ".0/24";
  if (raw.includes(":")) return raw.split(":").slice(0, 4).join(":") + "::/64";
  return "unknown";
}

export async function requestFingerprint(request, label) {
  return sha256Hex(`${label}\0${clientIpPrefix(request)}`);
}

export async function userAgentHash(request) {
  const value = request.headers.get("User-Agent");
  return value ? sha256Hex(value) : null;
}
