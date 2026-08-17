import { COLLECTION } from "./contracts.js";
import { guardIndexerRun, guardRpcCall } from "./safety.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SECONDS_PER_BLOCK = 12;
const SECONDS_PER_DAY = 86400;
const DEFAULT_MAX_BLOCK_RANGE = 100;
const HARD_MAX_BLOCK_RANGE = 5000;
const DEFAULT_MAX_LOGS_PER_RUN = 1000;

export function buildDefaultChainState(tokenId) {
  return {
    tokenId,
    owner: null,
    transferCount: 0,
    saleCount: 0,
    mintedAtBlock: null,
    holderSinceBlock: null,
    holderAgeDays: 0,
    lastTransferBlock: null,
    lastSaleBlock: null,
    lastSalePriceWei: null,
    lastSalePriceEth: null,
    saleTier: "none",
    latestBlock: null,
    gasGwei: null,
    gasLevel: "idle",
    evolutionTier: "new",
    source: "default"
  };
}

export function buildDefaultChainSummary(env = {}) {
  return {
    latestBlock: null,
    indexedToBlock: null,
    gasWei: null,
    gasGwei: null,
    gasLevel: "idle",
    updatedAt: null,
    source: env.DB ? "empty" : "default"
  };
}

export async function readTokenChainState(env, tokenId) {
  const metrics = await safeReadChainSummary(env);
  if (!env.DB) {
    return withComputedState(buildDefaultChainState(tokenId), metrics);
  }

  let row = null;
  try {
    row = await env.DB
      .prepare(
        `SELECT token_id, owner_address, minted_at_block, holder_since_block, last_transfer_block,
          transfer_count, sale_count, last_sale_block, last_sale_price_wei, updated_at
         FROM token_chain_state
         WHERE token_id = ?`
      )
      .bind(tokenId)
      .first();
  } catch (error) {
    console.error("MotorHeads chain-state read fell back to default", error);
    return withComputedState({ ...buildDefaultChainState(tokenId), source: "fallback" }, metrics);
  }

  if (!row) {
    return withComputedState(buildDefaultChainState(tokenId), metrics);
  }

  return withComputedState(
    {
      tokenId: row.token_id,
      owner: row.owner_address,
      transferCount: row.transfer_count || 0,
      saleCount: row.sale_count || 0,
      mintedAtBlock: row.minted_at_block,
      holderSinceBlock: row.holder_since_block,
      holderAgeDays: 0,
      lastTransferBlock: row.last_transfer_block,
      lastSaleBlock: row.last_sale_block,
      lastSalePriceWei: saleWeiForAnimation(row.last_sale_price_wei),
      lastSalePriceEth: weiToEthString(row.last_sale_price_wei),
      saleTier: saleTierFromWei(row.last_sale_price_wei),
      latestBlock: null,
      gasGwei: null,
      gasLevel: "idle",
      evolutionTier: "new",
      updatedAt: row.updated_at,
      source: "indexer"
    },
    metrics
  );
}

export async function readChainSummary(env) {
  const fallback = buildDefaultChainSummary(env);

  if (!env.DB) {
    return fallback;
  }

  const [metrics, checkpoint] = await Promise.all([
    env.DB
      .prepare("SELECT latest_block, gas_wei, gas_level, updated_at FROM chain_metrics WHERE metric_key = ?")
      .bind("ethereum-mainnet")
      .first(),
    env.DB
      .prepare("SELECT indexed_to_block, updated_at FROM chain_indexer_checkpoint WHERE checkpoint_key = ?")
      .bind("motorheads-transfer-indexer")
      .first()
  ]);

  if (!metrics && !checkpoint) {
    return fallback;
  }

  const gasWei = metrics?.gas_wei || null;
  return {
    latestBlock: metrics?.latest_block || null,
    indexedToBlock: checkpoint?.indexed_to_block || null,
    gasWei,
    gasGwei: gasWei ? Number(BigInt(gasWei)) / 1e9 : null,
    gasLevel: metrics?.gas_level || "idle",
    updatedAt: metrics?.updated_at || checkpoint?.updated_at || null,
    source: "indexer"
  };
}

async function safeReadChainSummary(env) {
  try {
    return await readChainSummary(env);
  } catch (error) {
    console.error("MotorHeads chain summary read fell back to default", error);
    return { ...buildDefaultChainSummary(env), source: "fallback" };
  }
}

export async function syncChainState(env, options = {}) {
  if (!env.DB) {
    return { ok: false, skipped: true, reason: "db_missing" };
  }

  const indexerGuard = await guardIndexerRun(env);
  if (!indexerGuard.allowed) {
    return { ok: false, skipped: true, reason: indexerGuard.code, safety: indexerGuard.details };
  }

  if (!env.ETH_RPC_URL) {
    return { ok: false, skipped: true, reason: "eth_rpc_url_missing" };
  }

  const deployBlock = cleanInteger(env.MOTORHEADS_DEPLOY_BLOCK, 0);
  if (!deployBlock) {
    return { ok: false, skipped: true, reason: "deploy_block_missing" };
  }

  const latestBlock = hexToNumber(await rpc(env, "eth_blockNumber"));
  const gasWei = BigInt(await rpc(env, "eth_gasPrice")).toString();
  const confirmations = cleanInteger(env.INDEXER_CONFIRMATIONS, 6);
  const safeLatestBlock = Math.max(deployBlock, latestBlock - confirmations);

  await writeChainMetrics(env, latestBlock, gasWei);

  const checkpoint = await env.DB
    .prepare("SELECT indexed_to_block, payload_json FROM chain_indexer_checkpoint WHERE checkpoint_key = ?")
    .bind("motorheads-transfer-indexer")
    .first();

  const checkpointBlock = checkpoint?.indexed_to_block || deployBlock - 1;
  const resumeCursor = readResumeCursor(checkpoint, checkpointBlock);
  const fromBlock = resumeCursor ? resumeCursor.blockNumber : Math.max(deployBlock, checkpointBlock + 1);
  if (fromBlock > safeLatestBlock) {
    return {
      ok: true,
      skipped: true,
      reason: "already_current",
      latestBlock,
      indexedToBlock: checkpointBlock,
      safeLatestBlock
    };
  }

  const maxRange = Math.max(1, Math.min(cleanInteger(env.INDEXER_MAX_BLOCK_RANGE, DEFAULT_MAX_BLOCK_RANGE), HARD_MAX_BLOCK_RANGE));
  const requestedToBlock = Math.min(safeLatestBlock, fromBlock + maxRange - 1);
  const logBatch = await readTransferLogs(env, fromBlock, requestedToBlock);
  const toBlock = logBatch.toBlock;
  const logs = logBatch.logs;

  const transferLogs = logs
    .map(parseTransferLog)
    .filter(Boolean)
    .filter((log) => !resumeCursor || log.blockNumber !== resumeCursor.blockNumber || log.logIndex > resumeCursor.logIndex)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const maxLogsPerRun = Math.max(1, cleanInteger(env.INDEXER_MAX_LOGS_PER_RUN, DEFAULT_MAX_LOGS_PER_RUN));
  const plan = buildTransferProcessingPlan(transferLogs, fromBlock, toBlock, maxLogsPerRun, {
    baseCheckpointToBlock: checkpointBlock
  });
  const txTransferCounts = countTransfersByTransaction(plan.logsToProcess);
  const txValueCache = new Map();
  let transfersProcessed = 0;
  let salesDetected = 0;

  for (const log of plan.logsToProcess) {
    const result = await applyTransferLog(env, log, txTransferCounts, txValueCache);
    if (result.processed) transfersProcessed += 1;
    if (result.saleDetected) salesDetected += 1;
  }

  await writeCheckpoint(env, plan.checkpointToBlock, {
    reason: options.reason || "manual",
    latestBlock,
    safeLatestBlock,
    requestedFromBlock: fromBlock,
    requestedToBlock,
    effectiveToBlock: toBlock,
    resumeCursor,
    nextCursor: plan.nextCursor,
    logFetchAttempts: logBatch.attempts,
    rawLogsFetched: logs.length,
    logsSeen: transferLogs.length,
    logsProcessed: plan.logsToProcess.length,
    logsDeferred: plan.logsDeferred,
    transfersProcessed,
    salesDetected,
    partial: plan.partial
  });

  return {
    ok: true,
    fromBlock,
    toBlock,
    indexedToBlock: plan.checkpointToBlock,
    latestBlock,
    safeLatestBlock,
    requestedToBlock,
    resumeCursor,
    nextCursor: plan.nextCursor,
    logFetchAttempts: logBatch.attempts,
    logsSeen: transferLogs.length,
    logsProcessed: plan.logsToProcess.length,
    logsDeferred: plan.logsDeferred,
    transfersProcessed,
    salesDetected,
    partial: plan.partial
  };
}

async function readTransferLogs(env, fromBlock, requestedToBlock) {
  let rangeSize = Math.max(1, requestedToBlock - fromBlock + 1);
  let attempts = 0;
  let lastError = null;

  while (rangeSize >= 1) {
    const toBlock = Math.min(requestedToBlock, fromBlock + rangeSize - 1);
    attempts += 1;
    try {
      const logs = await rpc(env, "eth_getLogs", [
        {
          address: COLLECTION.contractAddress,
          fromBlock: toQuantity(fromBlock),
          toBlock: toQuantity(toBlock),
          topics: [TRANSFER_TOPIC]
        }
      ]);
      return { logs, toBlock, requestedToBlock, attempts };
    } catch (error) {
      lastError = error;
      if (rangeSize === 1) break;
      rangeSize = Math.max(1, Math.floor(rangeSize / 2));
    }
  }

  throw lastError || new Error("Unable to fetch transfer logs.");
}

export function buildTransferProcessingPlan(transferLogs, fromBlock, toBlock, maxLogsPerRun, options = {}) {
  const sortedLogs = [...transferLogs].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  if (!sortedLogs.length) {
    return {
      logsToProcess: [],
      checkpointToBlock: toBlock,
      logsDeferred: 0,
      partial: false,
      nextCursor: null
    };
  }

  const budget = Math.max(1, Math.floor(Number(maxLogsPerRun) || DEFAULT_MAX_LOGS_PER_RUN));
  const logsToProcess = sortedLogs.slice(0, budget);
  const remainingLogs = sortedLogs.slice(logsToProcess.length);
  const partial = remainingLogs.length > 0;
  const baseCheckpointToBlock = cleanInteger(options.baseCheckpointToBlock, fromBlock - 1);
  let checkpointToBlock = toBlock;
  let nextCursor = null;

  if (partial) {
    const lastProcessedLog = logsToProcess[logsToProcess.length - 1];
    const nextLog = remainingLogs[0];
    if (lastProcessedLog && nextLog?.blockNumber === lastProcessedLog.blockNumber) {
      const previousCompleteLog = [...logsToProcess].reverse().find((log) => log.blockNumber < lastProcessedLog.blockNumber);
      checkpointToBlock = previousCompleteLog?.blockNumber || baseCheckpointToBlock;
      nextCursor = {
        blockNumber: lastProcessedLog.blockNumber,
        logIndex: lastProcessedLog.logIndex
      };
    } else {
      checkpointToBlock = lastProcessedLog?.blockNumber || baseCheckpointToBlock;
    }
  }

  return {
    logsToProcess,
    checkpointToBlock,
    logsDeferred: sortedLogs.length - logsToProcess.length,
    partial,
    nextCursor
  };
}

function readResumeCursor(checkpoint, checkpointBlock) {
  const payload = parseJsonObject(checkpoint?.payload_json);
  const cursor = payload?.nextCursor;
  if (!cursor) return null;

  const blockNumber = cleanInteger(cursor.blockNumber, 0);
  const logIndex = cleanInteger(cursor.logIndex, -1);
  if (blockNumber <= checkpointBlock || logIndex < 0) return null;
  return { blockNumber, logIndex };
}

function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function applyTransferLog(env, log, txTransferCounts, txValueCache) {
  const now = new Date().toISOString();
  const isMint = log.from === ZERO_ADDRESS;
  const eventId = `${log.transactionHash}:${log.logIndex}`;
  const transferCountForTx = txTransferCounts.get(log.transactionHash) || 1;
  const txValueWei = isMint ? 0n : await readTransactionValue(env, log.transactionHash, txValueCache);
  const saleDetected = !isMint && txValueWei > 0n;
  const salePriceWei = saleDetected ? (txValueWei / BigInt(transferCountForTx)).toString() : null;

  const insert = await env.DB
    .prepare(
      `INSERT OR IGNORE INTO chain_event
        (event_id, token_id, event_type, block_number, tx_hash, from_address, to_address, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      eventId,
      log.tokenId,
      saleDetected ? "sale" : isMint ? "mint" : "transfer",
      log.blockNumber,
      log.transactionHash,
      log.from,
      log.to,
      JSON.stringify({ logIndex: log.logIndex, nativeValueWei: txValueWei.toString(), salePriceWei }),
      now
    )
    .run();

  if (!insert.meta?.changes) {
    return { processed: false, saleDetected: false };
  }

  const current = await env.DB
    .prepare("SELECT transfer_count, sale_count, minted_at_block FROM token_chain_state WHERE token_id = ?")
    .bind(log.tokenId)
    .first();

  const transferCount = (current?.transfer_count || 0) + (isMint ? 0 : 1);
  const saleCount = (current?.sale_count || 0) + (saleDetected ? 1 : 0);
  const mintedAtBlock = current?.minted_at_block || (isMint ? log.blockNumber : null);

  await env.DB
    .prepare(
      `INSERT INTO token_chain_state
        (token_id, owner_address, minted_at_block, holder_since_block, last_transfer_block,
         transfer_count, sale_count, last_sale_block, last_sale_price_wei, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(token_id) DO UPDATE SET
        owner_address = excluded.owner_address,
        minted_at_block = COALESCE(token_chain_state.minted_at_block, excluded.minted_at_block),
        holder_since_block = excluded.holder_since_block,
        last_transfer_block = excluded.last_transfer_block,
        transfer_count = excluded.transfer_count,
        sale_count = excluded.sale_count,
        last_sale_block = COALESCE(excluded.last_sale_block, token_chain_state.last_sale_block),
        last_sale_price_wei = COALESCE(excluded.last_sale_price_wei, token_chain_state.last_sale_price_wei),
        updated_at = excluded.updated_at`
    )
    .bind(
      log.tokenId,
      log.to,
      mintedAtBlock,
      log.blockNumber,
      isMint ? current?.last_transfer_block || null : log.blockNumber,
      transferCount,
      saleCount,
      saleDetected ? log.blockNumber : null,
      salePriceWei,
      now
    )
    .run();

  return { processed: true, saleDetected };
}

async function readTransactionValue(env, txHash, cache) {
  if (cache.has(txHash)) return cache.get(txHash);
  const tx = await rpc(env, "eth_getTransactionByHash", [txHash]);
  const value = BigInt(tx?.value || "0x0");
  cache.set(txHash, value);
  return value;
}

async function writeChainMetrics(env, latestBlock, gasWei) {
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO chain_metrics (metric_key, latest_block, gas_wei, gas_level, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(metric_key) DO UPDATE SET
        latest_block = excluded.latest_block,
        gas_wei = excluded.gas_wei,
        gas_level = excluded.gas_level,
        updated_at = excluded.updated_at`
    )
    .bind("ethereum-mainnet", latestBlock, gasWei, gasLevelFromWei(gasWei, env), now)
    .run();
}

async function writeCheckpoint(env, indexedToBlock, payload) {
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO chain_indexer_checkpoint
        (checkpoint_key, indexed_to_block, updated_at, payload_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(checkpoint_key) DO UPDATE SET
        indexed_to_block = excluded.indexed_to_block,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json`
    )
    .bind("motorheads-transfer-indexer", indexedToBlock, now, JSON.stringify(payload))
    .run();
}

function withComputedState(state, metrics) {
  const holderAgeDays = estimateHolderAgeDays(state.holderSinceBlock, metrics.latestBlock);
  const saleTier = state.saleTier || saleTierFromWei(state.lastSalePriceWei);
  return {
    ...state,
    saleTier,
    lastSalePriceEth: state.lastSalePriceEth ?? weiToEthString(state.lastSalePriceWei),
    holderAgeDays,
    latestBlock: metrics.latestBlock,
    gasGwei: metrics.gasGwei,
    gasLevel: metrics.gasLevel,
    evolutionTier: evolutionTier(holderAgeDays)
  };
}

export function saleTierFromWei(value) {
  const wei = parseWei(value);
  if (wei >= 10000000000000000000n) return "mythic";
  if (wei >= 7000000000000000000n) return "legendary";
  if (wei >= 5000000000000000000n) return "royal";
  if (wei >= 2000000000000000000n) return "gold";
  if (wei >= 1000000000000000000n) return "silver";
  if (wei > 0n) return "verified";
  return "none";
}

export function saleWeiForAnimation(value) {
  const wei = parseWei(value);
  if (wei <= 0n) return null;
  const text = wei.toString();
  // The live pinned animation parser treats short decimal saleWei values as ETH.
  // Left-padding keeps the same wei integer while forcing the animation's wei path.
  return text.length < 16 ? text.padStart(16, "0") : text;
}

function weiToEthString(value) {
  const wei = parseWei(value);
  if (wei <= 0n) return null;
  const whole = wei / 1000000000000000000n;
  const fraction = wei % 1000000000000000000n;
  const fractionText = fraction.toString().padStart(18, "0").replace(/0+$/, "");
  return fractionText ? `${whole}.${fractionText}` : whole.toString();
}

function parseWei(value) {
  if (typeof value === "bigint") return value > 0n ? value : 0n;
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) return 0n;
  try {
    const wei = BigInt(text);
    return wei > 0n ? wei : 0n;
  } catch {
    return 0n;
  }
}

function estimateHolderAgeDays(holderSinceBlock, latestBlock) {
  if (!holderSinceBlock || !latestBlock || latestBlock < holderSinceBlock) {
    return 0;
  }
  return Math.floor(((latestBlock - holderSinceBlock) * SECONDS_PER_BLOCK) / SECONDS_PER_DAY);
}

function evolutionTier(days) {
  if (days >= 365) return "one-year";
  if (days >= 300) return "ten-months";
  if (days >= 150) return "five-months";
  if (days >= 60) return "two-months";
  if (days >= 30) return "one-month";
  if (days >= 14) return "two-weeks";
  if (days >= 7) return "one-week";
  if (days >= 3) return "three-days";
  if (days >= 1) return "one-day";
  return "new";
}

function gasLevelFromWei(gasWei, env) {
  const gwei = Number(BigInt(gasWei)) / 1e9;
  const low = cleanNumber(env.GAS_LOW_GWEI, 15);
  const medium = cleanNumber(env.GAS_MEDIUM_GWEI, 45);
  const high = cleanNumber(env.GAS_HIGH_GWEI, 90);
  if (gwei < low) return "low";
  if (gwei < medium) return "medium";
  if (gwei < high) return "high";
  return "extreme";
}

function parseTransferLog(log) {
  if (!Array.isArray(log.topics) || log.topics.length < 4) {
    return null;
  }
  return {
    tokenId: hexToNumber(log.topics[3]),
    from: topicToAddress(log.topics[1]),
    to: topicToAddress(log.topics[2]),
    blockNumber: hexToNumber(log.blockNumber),
    logIndex: hexToNumber(log.logIndex),
    transactionHash: log.transactionHash
  };
}

function countTransfersByTransaction(logs) {
  const counts = new Map();
  for (const log of logs) {
    if (log.from === ZERO_ADDRESS) continue;
    counts.set(log.transactionHash, (counts.get(log.transactionHash) || 0) + 1);
  }
  return counts;
}

async function rpc(env, method, params = []) {
  const rpcGuard = await guardRpcCall(env);
  if (!rpcGuard.allowed) {
    throw new Error(`${rpcGuard.message} ${JSON.stringify(rpcGuard.details)}`);
  }

  const response = await fetch(env.ETH_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || `Ethereum RPC ${method} failed.`);
  }
  return body.result;
}

function topicToAddress(topic) {
  return `0x${String(topic).slice(-40)}`.toLowerCase();
}

// ---- applied whole-machine EFFECT (from the token's on-chain garage) ----
// The garage (ERC-6551 token-bound account) holds the ERC-1155 effect parts a holder wins from crates.
// We report which effect the token has so the live animation can render it. Fail-closed to null: any RPC
// issue / missing config just means "no effect" — the animation is byte-identical to today.
const EFFECT_CRATES_ADDR = "0x50Dc22553988de047a00328963faEe8EC5E19b12"; // ScrapCrates (garageOf)
const EFFECT_PARTS_ADDR = "0x3f6ADfe2fA714c28B2c6ec4762D089069675f2a2"; // ScrapParts (ERC-1155 balanceOf)
// premium WebGL effects (partIds 4-12) listed FIRST so a token owning one shows it over a legacy 2D effect (1-3).
const EFFECT_PART_IDS = [
  [4, "living"], [5, "molten"], [6, "gold"], [7, "plasma"], [8, "crystal"], [9, "aurora"], [10, "mercury"], [11, "toxic"], [12, "hologram"],
  [1, "neon"], [2, "holo"], [3, "teal"],
];
const effUint = (n) => BigInt(n).toString(16).padStart(64, "0");
const effAddr = (a) => String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");

// Animated backgrounds occupy partIds 13-36 — a SEPARATE garage slot from effects (a token can hold one of each).
// Vol. 1 = 13-24; Vol. 2 = 25-36 (the "Backgrounds Vol. 2" crate). Must match webgl-bg BG_PART_KEYS + the site.
const BG_PART_IDS = [
  [13, "nebula"], [14, "blackhole"], [15, "waterfall"], [16, "leaves"], [17, "wolf"], [18, "moon"],
  [19, "aurora"], [20, "rain"], [21, "butterflies"], [22, "flowers"], [23, "confetti"], [24, "rainbow"],
  [25, "aquarium"], [26, "synthwave"], [27, "matrix"], [28, "koi"], [29, "lofirain"], [30, "jellyfish"],
  [31, "warp"], [32, "fireflies"], [33, "sakura"], [34, "lavalamp"], [35, "snow"], [36, "neoncity"],
];

async function readGarage(env, tokenId) {
  const garageRes = await rpc(env, "eth_call", [{ to: EFFECT_CRATES_ADDR, data: "0x3500754c" + effUint(tokenId) }, "latest"]); // garageOf(uint256)
  const garage = "0x" + String(garageRes || "").slice(-40);
  return (!garage || /^0*$/.test(garage.replace(/^0x/, ""))) ? null : garage;
}

// balanceOfBatch(address[],uint256[])=0x4e1273f4 — ONE call for the whole part list; first owned (list order) wins.
async function readFirstOwnedKey(env, garage, partList) {
  const n = partList.length;
  const offsets = effUint(0x40) + effUint(0x40 + 32 + 32 * n); // dyn-array offsets: accounts[] then ids[]
  const acctArr = effUint(n) + partList.map(() => effAddr(garage)).join("");
  const idsArr = effUint(n) + partList.map(([pid]) => effUint(pid)).join("");
  const balRes = await rpc(env, "eth_call", [{ to: EFFECT_PARTS_ADDR, data: "0x4e1273f4" + offsets + acctArr + idsArr }, "latest"]);
  const hex = String(balRes || "").replace(/^0x/, "");
  for (let i = 0; i < n; i++) {
    const word = hex.slice((2 + i) * 64, (3 + i) * 64) || "0"; // skip the offset + length words
    if (BigInt("0x" + word) > 0n) return partList[i][1];
  }
  return null;
}

// ---- on-chain EQUIP (opt-in): the holder pays a fee to CHOOSE which owned effect/bg shows (MotorHeadsEquip) ----
// When EQUIP_READS === "true" the animation shows ONLY what the holder explicitly equipped (equippedId 0 = none),
// NOT whatever they happen to own. equippedEffect/Background == 0 means "none" whether never-set (opt-in default)
// or explicitly unequipped — so no extra flag is needed. Existing owners are seeded once via grandfather() so their
// current effect doesn't vanish when this flips on. Flip the switch (set EQUIP_READS) only AFTER grandfather runs.
const EQUIP_ADDR = "0xF16E4CD4a69763106D01AbFF2234e65235681A8A";
const SEL_EQUIPPED_OF = "0x076ce9c1"; // equippedOf(uint256) -> (effectId, backgroundId)
const CRATE_OPENED_TOPIC = "0x4c7db30c9ea815193c7b81c81b90212975e0a72ab83f9cb8be9d3940b9322320"; // CrateOpened(uint256,uint256,address,uint256,uint256)
const idToEffectKey = new Map(EFFECT_PART_IDS.map(([id, key]) => [id, key]));
const idToBgKey = new Map(BG_PART_IDS.map(([id, key]) => [id, key]));

async function readEquippedIds(env, tokenId) {
  const res = await rpc(env, "eth_call", [{ to: EQUIP_ADDR, data: SEL_EQUIPPED_OF + effUint(tokenId) }, "latest"]);
  const hex = String(res || "").replace(/^0x/, "");
  const effectId = Number(BigInt("0x" + (hex.slice(0, 64) || "0")));
  const backgroundId = Number(BigInt("0x" + (hex.slice(64, 128) || "0")));
  return { effectId, backgroundId };
}

export async function readTokenEffect(env, tokenId) {
  if (!env.ETH_RPC_URL) return null;
  try {
    if (env.EQUIP_READS === "true") {
      const { effectId } = await readEquippedIds(env, tokenId);
      return idToEffectKey.get(effectId) || null; // only the explicitly-equipped effect (0 -> none)
    }
    const g = await readGarage(env, tokenId);
    return g ? await readFirstOwnedKey(env, g, EFFECT_PART_IDS) : null; // legacy: first-owned
  }
  catch (error) { console.warn("readTokenEffect failed (returning null):", error?.message || error); return null; }
}

export async function readTokenBackground(env, tokenId) {
  if (!env.ETH_RPC_URL) return null;
  try {
    if (env.EQUIP_READS === "true") {
      const { backgroundId } = await readEquippedIds(env, tokenId);
      return idToBgKey.get(backgroundId) || null;
    }
    const g = await readGarage(env, tokenId);
    return g ? await readFirstOwnedKey(env, g, BG_PART_IDS) : null;
  }
  catch (error) { console.warn("readTokenBackground failed (returning null):", error?.message || error); return null; }
}

// balanceOfBatch → ALL keys the garage owns from partList (not just the first). One RPC call.
async function readAllOwnedKeys(env, garage, partList) {
  const n = partList.length;
  const offsets = effUint(0x40) + effUint(0x40 + 32 + 32 * n);
  const acctArr = effUint(n) + partList.map(() => effAddr(garage)).join("");
  const idsArr = effUint(n) + partList.map(([pid]) => effUint(pid)).join("");
  const balRes = await rpc(env, "eth_call", [{ to: EFFECT_PARTS_ADDR, data: "0x4e1273f4" + offsets + acctArr + idsArr }, "latest"]);
  const hex = String(balRes || "").replace(/^0x/, "");
  const owned = [];
  for (let i = 0; i < n; i++) {
    const word = hex.slice((2 + i) * 64, (3 + i) * 64) || "0";
    if (BigInt("0x" + word) > 0n) owned.push(partList[i][1]);
  }
  return owned;
}

// Which effect + background keys a token's garage OWNS (inventory) — a wallet-independent read for the site's
// Effects tab (its own eth_call goes through the holder's wallet, which breaks if they're on the wrong network).
export async function readTokenOwnedParts(env, tokenId) {
  if (!env.ETH_RPC_URL) return { effects: [], backgrounds: [] };
  try {
    const g = await readGarage(env, tokenId);
    if (!g) return { effects: [], backgrounds: [] };
    const effects = await readAllOwnedKeys(env, g, EFFECT_PART_IDS);
    const backgrounds = await readAllOwnedKeys(env, g, BG_PART_IDS);
    return { effects, backgrounds };
  } catch (error) { console.warn("readTokenOwnedParts failed:", error?.message || error); return { effects: [], backgrounds: [] }; }
}

// balanceOfBatch first-owned but returns the PART ID (0 = none) — for the grandfather snapshot.
async function readFirstOwnedId(env, garage, partList) {
  const n = partList.length;
  const offsets = effUint(0x40) + effUint(0x40 + 32 + 32 * n);
  const acctArr = effUint(n) + partList.map(() => effAddr(garage)).join("");
  const idsArr = effUint(n) + partList.map(([pid]) => effUint(pid)).join("");
  const balRes = await rpc(env, "eth_call", [{ to: EFFECT_PARTS_ADDR, data: "0x4e1273f4" + offsets + acctArr + idsArr }, "latest"]);
  const hex = String(balRes || "").replace(/^0x/, "");
  for (let i = 0; i < n; i++) {
    const word = hex.slice((2 + i) * 64, (3 + i) * 64) || "0";
    if (BigInt("0x" + word) > 0n) return partList[i][0];
  }
  return 0;
}

// Accumulate ALL logs across [fromBlock, toBlock], halving the chunk on RPC range errors.
async function getLogsRange(env, address, topics, fromBlock, toBlock) {
  const out = [];
  let from = fromBlock;
  let chunk = 5000;
  while (from <= toBlock) {
    const to = Math.min(toBlock, from + chunk - 1);
    try {
      const logs = await rpc(env, "eth_getLogs", [{ address, topics, fromBlock: toQuantity(from), toBlock: toQuantity(to) }]);
      out.push(...logs);
      from = to + 1;
      if (chunk < 5000) chunk = Math.min(5000, chunk * 2);
    } catch (error) {
      if (chunk === 1) throw error;
      chunk = Math.max(1, Math.floor(chunk / 2));
    }
  }
  return out;
}

// The one-time grandfather snapshot: every token that has EVER opened a crate, mapped to the effect + background
// it CURRENTLY shows (first-owned — identical to the legacy read). The founder passes this to equip.grandfather()
// so those NFTs keep their look when EQUIP_READS flips on. Public read (all inputs are on-chain events).
export async function readEquipGrandfatherList(env) {
  if (!env.ETH_RPC_URL) return { tokenIds: [], effectIds: [], backgroundIds: [], count: 0 };
  const latest = Number(BigInt(await rpc(env, "eth_blockNumber", [])));
  const fromBlock = Math.max(0, latest - 120000); // ~3 weeks, well before the 2026-08 crate launch
  const logs = await getLogsRange(env, EFFECT_CRATES_ADDR, [CRATE_OPENED_TOPIC], fromBlock, latest);
  const tokenSet = new Set();
  for (const lg of logs) {
    if (lg?.topics?.[1]) tokenSet.add(Number(BigInt(lg.topics[1]))); // machineTokenId is the first indexed arg
  }
  const tokenIds = [], effectIds = [], backgroundIds = [];
  let skippedAlreadyEquipped = 0;
  for (const tid of [...tokenSet].sort((a, b) => a - b)) {
    // Skip any token that already has an equip state (revision > 0) — grandfathered or holder-equipped — so a
    // RE-RUN (to sweep late crate-openers) never overwrites a holder's paid choice back to first-owned.
    const revRes = await rpc(env, "eth_call", [{ to: EQUIP_ADDR, data: "0x9418fe56" + effUint(tid) }, "latest"]); // equipRevision(uint256)
    if (BigInt(revRes || "0x0") > 0n) { skippedAlreadyEquipped++; continue; }
    const g = await readGarage(env, tid);
    if (!g) continue;
    const eid = await readFirstOwnedId(env, g, EFFECT_PART_IDS);
    const bid = await readFirstOwnedId(env, g, BG_PART_IDS);
    if (eid || bid) { tokenIds.push(tid); effectIds.push(eid); backgroundIds.push(bid); }
  }
  return { tokenIds, effectIds, backgroundIds, count: tokenIds.length, scannedOpens: logs.length, skippedAlreadyEquipped };
}

function hexToNumber(hex) {
  return Number(BigInt(hex || "0x0"));
}

function toQuantity(value) {
  return `0x${Number(value).toString(16)}`;
}

function cleanInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function cleanNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
