import { keccak256, toBytes } from "viem";

export function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not allow non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Canonical JSON contains an unsupported value.");
}

export function hashNormalizedState(state) {
  const canonicalJson = canonicalize(state);
  return { canonicalJson, stateHash: keccak256(toBytes(canonicalJson)) };
}
