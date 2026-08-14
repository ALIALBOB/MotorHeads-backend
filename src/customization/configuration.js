import { CUSTOMIZATION_CHAIN_ID, CUSTOMIZATION_CONTRACT } from "./constants.js";
import { ApiError } from "./http.js";

function validHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.host);
  } catch {
    return false;
  }
}

function exactOrigins(value) {
  const origins = String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!origins.length) return false;
  return origins.every((entry) => {
    try {
      const url = new URL(entry);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === entry && entry !== "*";
    } catch {
      return false;
    }
  });
}

function siwePairMatches(env) {
  const domain = String(env.CUSTOMIZATION_SIWE_DOMAIN || "").trim();
  const uri = String(env.CUSTOMIZATION_SIWE_URI || "").trim();
  if (!domain || !validHttpUrl(uri)) return false;
  return new URL(uri).host === domain;
}

export function customizationConfigurationFailures(env = {}, scope = "write") {
  const failures = [];
  if (!env.DB || typeof env.DB.prepare !== "function") failures.push("D1_BINDING_MISSING");
  if (scope === "read") return failures;

  if (!validHttpUrl(env.ETH_RPC_URL)) failures.push("ETH_RPC_MISSING_OR_INVALID");
  if (!exactOrigins(env.CUSTOMIZATION_ALLOWED_ORIGINS)) failures.push("ALLOWED_ORIGINS_MISSING_OR_INVALID");
  if (!siwePairMatches(env)) failures.push("SIWE_DOMAIN_URI_INVALID");
  if (Number(env.CUSTOMIZATION_CHAIN_ID) !== CUSTOMIZATION_CHAIN_ID) failures.push("CHAIN_ID_UNSUPPORTED");
  if (String(env.CUSTOMIZATION_SUPPORTED_CONTRACT || "").trim().toLowerCase() !== CUSTOMIZATION_CONTRACT) {
    failures.push("SUPPORTED_CONTRACT_INVALID");
  }
  if (scope === "write" && !validHttpUrl(env.HOLDER_PLACEMENT_BASE_URL)) {
    failures.push("PLACEMENT_BASE_URL_MISSING_OR_INVALID");
  }
  return failures;
}

export function assertCustomizationConfiguration(env = {}, scope = "write") {
  const failures = customizationConfigurationFailures(env, scope);
  if (!failures.length) return;
  console.error("Customization configuration invalid", scope, failures.join(","));
  throw new ApiError(
    503,
    "CUSTOMIZATION_CONFIGURATION_INVALID",
    "Customization service configuration is incomplete.",
    { retryable: false }
  );
}
