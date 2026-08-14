// Crate-opening signer. A holder commits a crate on-chain (commitOpen → requestId), then calls this endpoint
// to get the signed randomness seed, then submits resolveOpen(requestId, seed, signature) themselves.
//
// The contract verifies:  ECDSA.recover( toEthSignedMessageHash(keccak256(abi.encodePacked(
//   chainid, cratesAddress, requestId, seed ))), signature ) == signer
// so we sign the raw inner keccak with the eth-signed-message prefix (viem `signMessage({message:{raw}})`).
//
// Fairness: the seed is DETERMINISTIC per requestId — seed = keccak256(requestId, SALT) — so re-requesting
// yields the SAME seed (no peek-and-reroll grinding), yet it's unpredictable to holders (depends on a backend
// secret salt). The weighting stays 100% on-chain. The signer is a DEDICATED key (never the treasury/main
// wallet); it can only authorize a seed — it cannot move funds or admin the contract.
import { keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { json, errorJson } from "./responses.js";

const DEFAULT_CRATES = "0x50Dc22553988de047a00328963faEe8EC5E19b12"; // mainnet ScrapCrates
const hex0x = (v) => (String(v).startsWith("0x") ? String(v) : "0x" + String(v));

export async function handleCrateSign(request, env) {
  if (!env.CRATE_SIGNER_KEY || !env.CRATE_SEED_SALT) {
    return errorJson(503, "signer_unconfigured", "The crate signer is not configured on this backend.", undefined, env);
  }
  let body;
  try { body = await request.json(); } catch { return errorJson(400, "bad_json", "Request body must be JSON.", undefined, env); }

  let requestId;
  try { requestId = BigInt(body?.requestId); } catch { return errorJson(400, "bad_request_id", "requestId must be an integer.", undefined, env); }
  if (requestId <= 0n) return errorJson(400, "bad_request_id", "requestId must be greater than 0.", undefined, env);

  const crates = env.CRATES_ADDRESS || DEFAULT_CRATES;
  const chainId = BigInt(env.CHAIN_ID || 1);

  // deterministic, unpredictable seed (un-grindable)
  const seed = BigInt(keccak256(encodePacked(["uint256", "bytes32"], [requestId, hex0x(env.CRATE_SEED_SALT)])));

  // the digest the contract recovers against
  const inner = keccak256(encodePacked(["uint256", "address", "uint256", "uint256"], [chainId, crates, requestId, seed]));

  let account, signature;
  try {
    account = privateKeyToAccount(hex0x(env.CRATE_SIGNER_KEY));
    signature = await account.signMessage({ message: { raw: inner } });
  } catch (err) {
    return errorJson(500, "sign_failed", "Failed to sign the crate seed.", undefined, env);
  }

  return json({
    ok: true,
    requestId: requestId.toString(),
    seed: "0x" + seed.toString(16).padStart(64, "0"),
    signature,
    signer: account.address,
  }, 200, env);
}
