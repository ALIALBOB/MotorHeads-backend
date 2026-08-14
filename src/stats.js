// stats.js — lightweight, self-owned monitoring for the MotorHeads dashboard.
//   • Page views: recorded into the existing `event_log` table (no new migration).
//     A per-day visitor hash (sha256(ip|day|salt), no raw IP stored) goes in the
//     unused owner_address column so we can count DISTINCT for uniques.
//   • On-chain edits: read live from the MotorHeadsParts companion via ETH_RPC_URL
//     (the same Alchemy secret the indexer uses) — edits are on-chain, so this is truth.
import { json, errorJson } from "./responses.js";
import { recoverMessageAddress, getAddress } from "viem";

const PARTS_CONTRACT = "0xed26E94663FA23CFb952771111770474c4F1f082"; // mainnet MotorHeadsParts companion
// Admin wallet allowed to view the dashboard. Defaults to the companion's treasury; override with env.ADMIN_ADDRESS.
const ADMIN_DEFAULT = "0x95A6fB3087b3469Ed777120052E0ac3f262c81C1";
function adminAddress(env) { try { return getAddress(env.ADMIN_ADDRESS || ADMIN_DEFAULT).toLowerCase(); } catch { return ADMIN_DEFAULT.toLowerCase(); } }

// Verify a fresh personal_sign from the admin wallet (no session/D1 dependency).
// The client sends X-Wallet-Address, X-Signature, and X-Signed-Message (base64 of the message, since
// headers can't hold newlines). The message embeds a Time: stamp so a captured signature can't be replayed forever.
async function verifyAdmin(request, env) {
  const wallet = request.headers.get("x-wallet-address");
  const signature = request.headers.get("x-signature");
  const b64 = request.headers.get("x-signed-message");
  if (!wallet || !signature || !b64) return false;
  let message;
  try { message = atob(b64); } catch { return false; }
  const tMatch = /Time:\s*(\S+)/.exec(message);
  const t = tMatch ? Date.parse(tMatch[1]) : NaN;
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 10 * 60 * 1000) return false; // 10-min freshness window
  let recovered;
  try { recovered = (await recoverMessageAddress({ message, signature })).toLowerCase(); } catch { return false; }
  return recovered === adminAddress(env);
}
const METADATA_UPDATE = "0xf8e1a15aba9398e019f0b49df1a4fde98ee17ae345cb5f6b5e2c27f5033e8ce7"; // keccak256("MetadataUpdate(uint256)")
const HIT_RANGE_BLOCKS = 150000; // ~20 days back — covers the companion's 2026-08-03 deploy

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const isSiteOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) || /(^|\.)motorheadsonline\.com$/.test((() => { try { return new URL(o).hostname; } catch { return ""; } })());

export async function recordHit(request, env) {
  // light same-origin guard so the counter can't be trivially spammed cross-site
  const origin = request.headers.get("origin") || "";
  if (origin && !isSiteOrigin(origin)) return json({ ok: true, skipped: "origin" }, {}, env);
  if (!env.DB) return json({ ok: true, skipped: "no_db" }, {}, env);

  let path = "/";
  try { const b = await request.json(); if (b && typeof b.path === "string") path = b.path.slice(0, 160); } catch {}
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "0";
  const day = new Date().toISOString().slice(0, 10);
  const vk = "vk:" + (await sha256hex(`${ip}|${day}|motorheads`)).slice(0, 28); // daily visitor hash, no raw IP
  const payload = JSON.stringify({ path, ref: (request.headers.get("referer") || "").slice(0, 200) || null });
  try {
    await env.DB
      .prepare("INSERT INTO event_log (id, token_id, owner_address, event_type, payload_json, created_at) VALUES (?, NULL, ?, 'page_view', ?, ?)")
      .bind(crypto.randomUUID(), vk, payload, new Date().toISOString())
      .run();
  } catch (e) { /* never fail a page load over analytics */ }
  return json({ ok: true }, {}, env);
}

async function rpc(env, method, params = []) {
  const r = await fetch(env.ETH_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result;
}

async function readEdits(env) {
  if (!env.ETH_RPC_URL) return { source: "no_rpc", tokensEdited: 0, saveEvents: 0, feesEth: null };
  const latest = parseInt(await rpc(env, "eth_blockNumber"), 16);
  const from = Math.max(0, latest - HIT_RANGE_BLOCKS);
  const logs = await rpc(env, "eth_getLogs", [{ address: PARTS_CONTRACT, fromBlock: "0x" + from.toString(16), toBlock: "latest" }]);
  // Count only real edits: MetadataUpdate(uint256) events with an in-range MotorHead token id (1..5555).
  // Other companion events (RoleGranted, TreasurySet, Swept…) carry non-tokenId topic1 values (role hashes,
  // addresses) that must NOT be counted as edited machines.
  const tokens = new Set();
  let saveEvents = 0;
  for (const l of logs || []) {
    if (!l.topics) continue;
    if (l.topics[0] === METADATA_UPDATE) saveEvents++; // ERC-4906 save signal (1 per applyParts)
    // Edited machines: any event carrying an indexed tokenId in topics[1] within the real range (1..5555).
    // Role hashes / addresses in topics[1] are 20–32-byte values, always far above 5555, so they're excluded.
    if (l.topics[1]) { try { const id = BigInt(l.topics[1]); if (id >= 1n && id <= 5555n) tokens.add(id.toString()); } catch {} }
  }
  const bal = await rpc(env, "eth_getBalance", [PARTS_CONTRACT, "latest"]);
  return {
    source: "chain",
    contract: PARTS_CONTRACT,
    tokensEdited: tokens.size,
    tokens: [...tokens].slice(0, 100),
    saveEvents: saveEvents || (logs || []).length,
    totalEvents: (logs || []).length,
    feesEth: (Number(BigInt(bal)) / 1e18).toFixed(5),
  };
}

export async function readStats(request, env) {
  // Gate: admin wallet signature (primary) OR the optional STATS_KEY (fallback for tooling).
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || request.headers.get("x-stats-key") || "";
  const keyOk = env.STATS_KEY && key === env.STATS_KEY;
  const adminOk = await verifyAdmin(request, env);
  if (!adminOk && !keyOk) {
    return errorJson(401, "admin_required", "Connect the admin wallet (or provide the dashboard key).", { admin: adminAddress(env) }, env);
  }

  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  let visitors = { total: 0, uniques: 0, views7: 0, uniques7: 0, viewsToday: 0, daily: [], source: env.DB ? "db" : "no_db" };
  if (env.DB) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const t = await env.DB.prepare("SELECT COUNT(*) c, COUNT(DISTINCT owner_address) u FROM event_log WHERE event_type='page_view'").first();
      const w = await env.DB.prepare("SELECT COUNT(*) c, COUNT(DISTINCT owner_address) u FROM event_log WHERE event_type='page_view' AND created_at>=?").bind(iso(now - 7 * 864e5)).first();
      const td = await env.DB.prepare("SELECT COUNT(*) c FROM event_log WHERE event_type='page_view' AND substr(created_at,1,10)=?").bind(today).first();
      const daily = await env.DB.prepare("SELECT substr(created_at,1,10) d, COUNT(*) c, COUNT(DISTINCT owner_address) u FROM event_log WHERE event_type='page_view' AND created_at>=? GROUP BY d ORDER BY d").bind(iso(now - 30 * 864e5)).all();
      visitors = { total: t?.c || 0, uniques: t?.u || 0, views7: w?.c || 0, uniques7: w?.u || 0, viewsToday: td?.c || 0, daily: (daily?.results || []).map((r) => ({ date: r.d, views: r.c, uniques: r.u })), source: "db" };
    } catch (e) { visitors.error = String(e.message || e).slice(0, 140); }
  }
  let edits = { source: "unavailable" };
  try { edits = await readEdits(env); } catch (e) { edits = { source: "error", error: String(e.message || e).slice(0, 140), feesEth: null, tokensEdited: 0, saveEvents: 0 }; }

  return json({ ok: true, visitors, edits, generatedAt: new Date().toISOString() }, {}, env);
}
