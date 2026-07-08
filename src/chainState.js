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
