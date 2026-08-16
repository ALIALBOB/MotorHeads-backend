// share.js — "Share to Earn" weekly X campaign.
//   Holders post about MotorHeads on X, paste the tweet link (holder-gated), and the founder approves
//   submissions in the admin dashboard. Approved posts earn crates; top posts win a premium crate bundle.
//   Rewards are granted on-chain OUT OF BAND by the founder (existing admin "DISTRIBUTE CRATES" tool /
//   a distributor round) — this module runs the engagement loop + produces the grant list. No new contracts.
//
// Routes (all under /v1/share/):
//   GET  /campaign         public  — current active campaign + prize copy
//   GET  /leaderboard      public  — approved posts this week (showcase)
//   POST /submit           holder  — { tweetUrl } → pending submission (SIWE session cookie + live balanceOf gate)
//   GET  /me               holder  — my submissions this week
//   GET  /admin/queue      admin   — pending submissions
//   POST /admin/review     admin   — { id, action:approve|reject, note }
//   POST /admin/winners    admin   — { ids:[...] } flag top posters (premium bundle)
//   GET  /admin/grants     admin   — approved wallets + crate amounts to grant on-chain
//   POST /admin/mark-granted admin — { ids:[...], ref } mark rewards paid
//   POST /admin/campaign   admin   — finalize current + open a new week
//
// Auth reuse: requireSession + readOwnerBalanceResilient (same holder gate as the Owner Canvas);
// admin = the same fresh personal_sign the dashboard already does for /v1/stats (or STATS_KEY).
import { json, errorJson, corsHeaders } from "./responses.js";
import { requireSession } from "./customization/auth.js";
import { readOwnerBalanceResilient } from "./customization/ownership.js";
import { MOTORHEADS_CONTRACT } from "./contracts.js";
import { ApiError } from "./customization/http.js";
import { recoverMessageAddress, getAddress } from "viem";

const ADMIN_DEFAULT = "0x95A6fB3087b3469Ed777120052E0ac3f262c81C1";
const WINNER_BONUS_CRATES = 5;   // top posters get base + this many extra crates (the "premium bundle")
const WEEK_SECONDS = 7 * 24 * 60 * 60;

const nowSec = () => Math.floor(Date.now() / 1000);
const changes = (r) => Number(r?.meta?.changes ?? r?.changes ?? 0);
const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
function adminAddress(env) { try { return getAddress(env.ADMIN_ADDRESS || ADMIN_DEFAULT).toLowerCase(); } catch { return ADMIN_DEFAULT.toLowerCase(); } }

// yyyy-Www ISO-week label (uniqueness + display only)
function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Extract { handle, id } from a tweet/x URL; null if it isn't a status link.
function parseTweet(url) {
  const m = String(url || "").match(/(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i);
  return m ? { handle: m[1], id: m[2] } : null;
}

async function readJson(request) {
  let txt;
  try { txt = await request.text(); } catch { throw new ApiError(400, "bad_json", "Could not read request body."); }
  if (txt && txt.length > 8192) throw new ApiError(413, "too_large", "Request body too large.");
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { throw new ApiError(400, "bad_json", "Invalid JSON body."); }
}

function campPublic(c) {
  return {
    weekKey: c.week_key, hashtag: c.hashtag, handle: c.handle, prizeDesc: c.prize_desc,
    baseReward: c.base_reward, topN: c.top_n, status: c.status,
    startsAt: c.starts_at, endsAt: c.ends_at,
  };
}

// One active campaign at a time; create a default one on first access so the feature always works.
async function ensureActiveCampaign(env) {
  const db = env.DB;
  let row = await db.prepare("SELECT * FROM mh_share_campaigns WHERE status='active' ORDER BY id DESC LIMIT 1").first();
  if (row) return row;
  const now = nowSec();
  const wk = isoWeekKey();
  const prize = "1 crate per approved post + top 3 posts win a premium crate bundle";
  await db.prepare(
    `INSERT OR IGNORE INTO mh_share_campaigns
       (week_key, hashtag, handle, prize_desc, base_reward, top_n, status, starts_at, ends_at, created_at)
     VALUES (?, '#MotorHeads', '@Motor_Heads_', ?, 1, 3, 'active', ?, ?, ?)`
  ).bind(wk, prize, now, now + WEEK_SECONDS, now).run();
  row = await db.prepare("SELECT * FROM mh_share_campaigns WHERE week_key=?").bind(wk).first();
  return row;
}

// ---- admin gate (mirrors stats.js verifyAdmin: fresh personal_sign OR STATS_KEY) ----
async function isAdmin(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || request.headers.get("x-stats-key") || "";
  if (env.STATS_KEY && key === env.STATS_KEY) return true;
  const wallet = request.headers.get("x-wallet-address");
  const signature = request.headers.get("x-signature");
  const b64 = request.headers.get("x-signed-message");
  if (!wallet || !signature || !b64) return false;
  let message; try { message = atob(b64); } catch { return false; }
  const tMatch = /Time:\s*(\S+)/.exec(message);
  const t = tMatch ? Date.parse(tMatch[1]) : NaN;
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 10 * 60 * 1000) return false; // 10-min freshness
  let recovered; try { recovered = (await recoverMessageAddress({ message, signature })).toLowerCase(); } catch { return false; }
  return recovered === adminAddress(env);
}
async function requireAdmin(request, env) {
  if (!(await isAdmin(request, env))) throw new ApiError(401, "admin_required", "Connect the admin wallet.", { admin: adminAddress(env) });
}

async function requireHolder(request, env) {
  const session = await requireSession(request, env);            // throws ApiError(401) without a valid session
  const address = String(session.address).toLowerCase();
  const balance = await readOwnerBalanceResilient(env, MOTORHEADS_CONTRACT, address);
  if (!(balance > 0)) throw new ApiError(403, "not_a_holder", "Only MotorHead holders can earn.");
  return address;
}

// ---------- public ----------
async function getCampaign(env) {
  const camp = await ensureActiveCampaign(env);
  return json({ ok: true, campaign: campPublic(camp) }, {}, env);
}

async function getLeaderboard(env) {
  const camp = await ensureActiveCampaign(env);
  const rows = (await env.DB.prepare(
    "SELECT wallet, tweet_url, author_handle, is_winner FROM mh_share_submissions WHERE campaign_id=? AND status='approved' ORDER BY is_winner DESC, reviewed_at DESC LIMIT 100"
  ).bind(camp.id).all()).results || [];
  const approved = rows.map((r) => ({ wallet: shortAddr(r.wallet), tweetUrl: r.tweet_url, handle: r.author_handle, winner: !!r.is_winner }));
  return json({ ok: true, campaign: campPublic(camp), approved }, {}, env);
}

// ---------- holder ----------
async function submit(request, env) {
  const address = await requireHolder(request, env);
  const body = await readJson(request);
  const tweetUrl = String(body.tweetUrl || "").trim().slice(0, 300);
  const t = parseTweet(tweetUrl);
  if (!t) return errorJson(400, "bad_tweet", "Paste a full link to your post, e.g. https://x.com/you/status/123…", undefined, env);
  const camp = await ensureActiveCampaign(env);
  try {
    await env.DB.prepare(
      `INSERT INTO mh_share_submissions (campaign_id, wallet, tweet_id, tweet_url, author_handle, status, submitted_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(camp.id, address, t.id, tweetUrl, t.handle, nowSec()).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message || e))) {
      const mine = await env.DB.prepare("SELECT id FROM mh_share_submissions WHERE campaign_id=? AND wallet=?").bind(camp.id, address).first();
      if (mine) return errorJson(409, "already_submitted", "You've already submitted a post this week — one per wallet.", undefined, env);
      return errorJson(409, "tweet_used", "That post was already submitted by someone.", undefined, env);
    }
    throw e;
  }
  return json({ ok: true, status: "pending", campaign: campPublic(camp) }, {}, env);
}

async function getMine(request, env) {
  const session = await requireSession(request, env);
  const address = String(session.address).toLowerCase();
  const camp = await ensureActiveCampaign(env);
  const rows = (await env.DB.prepare(
    "SELECT id, tweet_url, status, is_winner, reward_kind, granted, note, submitted_at, reviewed_at FROM mh_share_submissions WHERE campaign_id=? AND wallet=? ORDER BY submitted_at DESC"
  ).bind(camp.id, address).all()).results || [];
  return json({ ok: true, campaign: campPublic(camp), submissions: rows }, {}, env);
}

// ---------- admin ----------
async function adminQueue(request, env) {
  await requireAdmin(request, env);
  const camp = await ensureActiveCampaign(env);
  const pending = (await env.DB.prepare(
    "SELECT id, wallet, tweet_id, tweet_url, author_handle, submitted_at FROM mh_share_submissions WHERE campaign_id=? AND status='pending' ORDER BY submitted_at ASC"
  ).bind(camp.id).all()).results || [];
  const counts = (await env.DB.prepare(
    "SELECT status, COUNT(*) n FROM mh_share_submissions WHERE campaign_id=? GROUP BY status"
  ).bind(camp.id).all()).results || [];
  return json({ ok: true, campaign: campPublic(camp), pending, counts }, {}, env);
}

async function adminReview(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const id = Number(body.id);
  const action = body.action;
  const note = String(body.note || "").slice(0, 300);
  if (!id || (action !== "approve" && action !== "reject")) return errorJson(400, "bad_input", "id + action(approve|reject) required.", undefined, env);
  const status = action === "approve" ? "approved" : "rejected";
  const rewardKind = action === "approve" ? "crate" : null;
  const res = await env.DB.prepare(
    "UPDATE mh_share_submissions SET status=?, reward_kind=?, note=?, reviewed_at=? WHERE id=? AND status='pending'"
  ).bind(status, rewardKind, note, nowSec(), id).run();
  if (changes(res) !== 1) return errorJson(409, "not_pending", "That submission was already reviewed or doesn't exist.", undefined, env);
  return json({ ok: true, id, status }, {}, env);
}

async function adminWinners(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
  const camp = await ensureActiveCampaign(env);
  // Reset winners for this campaign, then flag the chosen ones (must be approved).
  await env.DB.prepare("UPDATE mh_share_submissions SET is_winner=0, reward_kind='crate' WHERE campaign_id=? AND status='approved'").bind(camp.id).run();
  let flagged = 0;
  for (const id of ids) {
    const res = await env.DB.prepare("UPDATE mh_share_submissions SET is_winner=1, reward_kind='crate_effect' WHERE id=? AND campaign_id=? AND status='approved'").bind(id, camp.id).run();
    flagged += changes(res);
  }
  return json({ ok: true, winners: flagged }, {}, env);
}

async function adminGrants(request, env) {
  await requireAdmin(request, env);
  const camp = await ensureActiveCampaign(env);
  const rows = (await env.DB.prepare(
    "SELECT id, wallet, is_winner, granted, grant_ref FROM mh_share_submissions WHERE campaign_id=? AND status='approved' ORDER BY is_winner DESC, id ASC"
  ).bind(camp.id).all()).results || [];
  const base = Number(camp.base_reward) || 1;
  const grants = rows.map((r) => ({
    id: r.id, wallet: r.wallet, winner: !!r.is_winner,
    crates: r.is_winner ? base + WINNER_BONUS_CRATES : base,
    granted: !!r.granted, grantRef: r.grant_ref || null,
  }));
  const pending = grants.filter((g) => !g.granted);
  const totalCrates = pending.reduce((n, g) => n + g.crates, 0);
  return json({ ok: true, campaign: campPublic(camp), grants, summary: { walletsToGrant: pending.length, totalCrates } }, {}, env);
}

async function adminMarkGranted(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
  const ref = String(body.ref || "").slice(0, 120);
  let n = 0;
  for (const id of ids) {
    const res = await env.DB.prepare("UPDATE mh_share_submissions SET granted=1, grant_ref=? WHERE id=?").bind(ref, id).run();
    n += changes(res);
  }
  return json({ ok: true, granted: n }, {}, env);
}

async function adminOpenCampaign(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request).catch(() => ({}));
  const now = nowSec();
  await env.DB.prepare("UPDATE mh_share_campaigns SET status='finalized' WHERE status='active'").run();
  const wk = String(body.weekKey || isoWeekKey()).slice(0, 16);
  const prize = String(body.prizeDesc || "1 crate per approved post + top 3 posts win a premium crate bundle").slice(0, 300);
  const base = Number(body.baseReward) || 1;
  const topN = Number(body.topN) || 3;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO mh_share_campaigns
       (week_key, hashtag, handle, prize_desc, base_reward, top_n, status, starts_at, ends_at, created_at)
     VALUES (?, '#MotorHeads', '@Motor_Heads_', ?, ?, ?, 'active', ?, ?, ?)`
  ).bind(wk, prize, base, topN, now, now + WEEK_SECONDS, now).run();
  // If that week already existed (finalized/archived), reactivate it.
  await env.DB.prepare("UPDATE mh_share_campaigns SET status='active', prize_desc=?, base_reward=?, top_n=? WHERE week_key=? AND status!='active'").bind(prize, base, topN, wk).run();
  const camp = await env.DB.prepare("SELECT * FROM mh_share_campaigns WHERE week_key=?").bind(wk).first();
  return json({ ok: true, campaign: campPublic(camp) }, {}, env);
}

// ---- router entry (called from index.js before the legacy route()) ----
export async function routeShareRequest(request, env, ctx) {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/v1/share/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (!env.DB || typeof env.DB.prepare !== "function") return errorJson(503, "db_unavailable", "Share storage is unavailable.", undefined, env);
  const { method } = request;
  try {
    if (method === "GET" && pathname === "/v1/share/campaign") return await getCampaign(env);
    if (method === "GET" && pathname === "/v1/share/leaderboard") return await getLeaderboard(env);
    if (method === "POST" && pathname === "/v1/share/submit") return await submit(request, env);
    if (method === "GET" && pathname === "/v1/share/me") return await getMine(request, env);
    if (method === "GET" && pathname === "/v1/share/admin/queue") return await adminQueue(request, env);
    if (method === "POST" && pathname === "/v1/share/admin/review") return await adminReview(request, env);
    if (method === "POST" && pathname === "/v1/share/admin/winners") return await adminWinners(request, env);
    if (method === "GET" && pathname === "/v1/share/admin/grants") return await adminGrants(request, env);
    if (method === "POST" && pathname === "/v1/share/admin/mark-granted") return await adminMarkGranted(request, env);
    if (method === "POST" && pathname === "/v1/share/admin/campaign") return await adminOpenCampaign(request, env);
    return errorJson(404, "not_found", "No share route matched.", { path: pathname }, env);
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error("share route error", err);
    return errorJson(status, err?.code || "share_error", err?.message || "Share error.", err?.details, env);
  }
}
