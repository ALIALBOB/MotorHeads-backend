#!/usr/bin/env python3
"""MotorHeads chain-indexer watchdog.

Pings Discord when the indexer stalls. Stateless + spam-safe: it only alerts when
the indexer is BOTH far behind AND not catching up, confirmed by a second reading
RECHECK_SECONDS later. A healthy catch-up (advancing ~1000 blocks/run) never alerts,
so it stays quiet while a backlog legitimately drains.

Why external: it polls the public endpoint from outside the worker, so it fires even
if the worker is completely dead — which an in-worker check can't do. That total-
silence failure mode is exactly what let a 10-day stall go unnoticed.
"""
import json
import os
import time
import urllib.request

SUMMARY_URL = os.environ["SUMMARY_URL"]
WEBHOOK = os.environ.get("DISCORD_ALERT_WEBHOOK_URL", "").strip()
LAG_ALERT_BLOCKS = int(os.environ.get("LAG_ALERT_BLOCKS", "1500"))
MIN_PROGRESS_BLOCKS = int(os.environ.get("MIN_PROGRESS_BLOCKS", "200"))
RECHECK_SECONDS = int(os.environ.get("RECHECK_SECONDS", "360"))
FORCE_PING = os.environ.get("FORCE_PING", "").lower() == "true"


def post_discord(content):
    if not WEBHOOK:
        print("WARNING: DISCORD_ALERT_WEBHOOK_URL not set. Would have posted:\n" + content)
        return
    body = json.dumps({
        "content": content,
        "username": "MotorHeads Indexer",
        "allowed_mentions": {"parse": []},
    }).encode()
    req = urllib.request.Request(WEBHOOK, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        print("Discord webhook status:", r.status)


def read_summary():
    # A real User-Agent — Cloudflare 403s the default python-urllib UA as a bot,
    # which would otherwise look like an outage and false-alarm.
    req = urllib.request.Request(SUMMARY_URL, headers={
        "accept": "application/json",
        "user-agent": "MotorHeads-Indexer-Watchdog/1.0 (+github-actions)",
    })
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.load(r)
    chain = data.get("chain", data)
    head = int(chain.get("latestBlock") or 0)
    indexed = int(chain.get("indexedToBlock") or 0)
    return head, indexed


def hours_behind(lag):
    return round(lag * 12 / 3600, 1)  # ~12s per Ethereum block


def main():
    if FORCE_PING:
        post_discord(
            "🧪 **MotorHeads indexer watchdog — test ping.** Wiring works. "
            "You'll get a 🔴 alert here if the indexer ever falls behind and stops catching up."
        )
        return

    # Reading 1
    try:
        head1, idx1 = read_summary()
    except Exception as e:  # noqa: BLE001
        post_discord(f"🔴 **MotorHeads backend unreachable** — chain summary failed: `{e}`. The indexer may be down.")
        return
    if not head1 or not idx1:
        print("Incomplete summary; skipping.", head1, idx1)
        return
    lag1 = head1 - idx1
    print(f"reading1 head={head1} indexed={idx1} lag={lag1}")
    if lag1 <= LAG_ALERT_BLOCKS:
        print("Within threshold; healthy. No alert.")
        return

    # Behind — confirm it's actually stuck (not just catching up) with a 2nd reading.
    print(f"lag {lag1} > {LAG_ALERT_BLOCKS}; re-checking in {RECHECK_SECONDS}s to confirm...")
    time.sleep(RECHECK_SECONDS)
    try:
        head2, idx2 = read_summary()
    except Exception as e:  # noqa: BLE001
        post_discord(f"🔴 **MotorHeads backend unreachable on recheck** — `{e}`. Indexer likely down (was {lag1:,} blocks behind).")
        return
    progress = idx2 - idx1
    lag2 = head2 - idx2
    print(f"reading2 head={head2} indexed={idx2} lag={lag2} progress={progress}")

    if progress < MIN_PROGRESS_BLOCKS:
        post_discord(
            "🔴 **MotorHeads indexer is STALLED.**\n"
            f"> Behind by **{lag2:,} blocks (~{hours_behind(lag2)}h)** and not catching up "
            f"(advanced only **{progress} blocks** in {RECHECK_SECONDS // 60} min).\n"
            f"> indexed `{idx2:,}` / head `{head2:,}`.\n"
            "Likely `ETH_RPC_URL` / archive `getLogs`. Per-token owner + sale data is going stale."
        )
    else:
        print(f"Behind but catching up (+{progress} blocks in {RECHECK_SECONDS // 60} min); no alert.")


if __name__ == "__main__":
    main()
