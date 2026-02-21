"""
Self-pay script — Trigger Bazaar cataloging by making payments to your own scout API.

Prerequisites:
  1. A temp wallet with USDC on Base Mainnet (from ≠ to required by CDP facilitator)
  2. Set EVM_PRIVATE_KEY env var with the temp wallet's private key
  3. The scout API must be running at SCOUT_API_URL

Usage (from weather-api venv which has x402 installed):
  cd /home/gen/projects/x402-weather-api
  source .venv/bin/activate
  export EVM_PRIVATE_KEY="0x..."
  python /home/gen/projects/scout-mcp/self_pay.py

What happens:
  1. Sends GET to each endpoint → receives 402 with payment requirements
  2. x402 client auto-creates USDC payment signature (EIP-3009, gasless)
  3. Retries request with payment → CDP facilitator verifies + settles
  4. CDP facilitator catalogs each endpoint on Bazaar Discovery
"""

import asyncio
import os
import sys

from eth_account import Account

from x402 import x402Client
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client

# --- Config ---
API_URL = os.getenv("SCOUT_API_URL", "https://scout.hugen.tokyo")
PRIVATE_KEY = os.getenv("EVM_PRIVATE_KEY")

if not PRIVATE_KEY:
    print("ERROR: Set EVM_PRIVATE_KEY environment variable")
    print("  export EVM_PRIVATE_KEY='0x...'")
    sys.exit(1)

# --- Safety: from != to check (地雷11) ---
# CDP facilitator rejects EIP-3009 where from == to with unhelpful
# "invalid_payload" error. This guard prevents hours of debugging.
EVM_ADDRESS = os.getenv("EVM_ADDRESS", "0x29322Ea7EcB34aA6164cb2ddeB9CE650902E4f60")
_payer = Account.from_key(PRIVATE_KEY).address
if _payer.lower() == EVM_ADDRESS.lower():
    print("FATAL: from == to detected!")
    print(f"  Payer (from): {_payer}")
    print(f"  Receiver (to): {EVM_ADDRESS}")
    print()
    print("CDP facilitator rejects self-pay where from == to.")
    print("Use a DIFFERENT wallet. See playbook 地雷11 for 2-pass procedure.")
    sys.exit(1)

# Only self-pay the cheap endpoints ($0.001 each)
# X ($0.20) and report/full ($0.25) are skipped to save cost
ENDPOINTS = [
    "/scout/hn?q=x402",
    "/scout/npm?q=mcp",
    "/scout/github?q=x402",
    "/scout/github/repo?owner=coinbase&repo=x402",
    "/scout/pypi?q=fastapi",
    "/scout/ph?q=ai-agents",
    "/scout/x402?q=weather",
    "/scout/report?q=x402",
]


async def main():
    client = x402Client()
    account = Account.from_key(PRIVATE_KEY)
    register_exact_evm_client(client, EthAccountSigner(account))

    print(f"Payer wallet: {account.address}")
    print(f"Target API:   {API_URL}")
    print(f"Endpoints:    {len(ENDPOINTS)} (skip X and report/full to save cost)")
    print()

    async with x402HttpxClient(client) as http:
        for ep in ENDPOINTS:
            url = f"{API_URL}{ep}"
            print(f"--- {ep} ---")
            try:
                response = await http.get(url)
                print(f"Status: {response.status_code}")
                print(f"Body:   {response.text[:200]}")
            except Exception as e:
                print(f"Error: {e}")
            print()

    print(f"Done! {len(ENDPOINTS)} endpoints should now be cataloged on Bazaar.")
    print("Check: https://www.x402.org/ecosystem")


if __name__ == "__main__":
    asyncio.run(main())
