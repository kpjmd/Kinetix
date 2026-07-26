# OKX AI — ASP Listing (Agent-to-MCP)

Runbook for listing Kinetix on OKX AI as a verification Agent Service Provider.

Registration is **Agent-to-MCP only**. Agent-to-Agent (negotiated scope, escrow,
sign-off) and Dispute Resolver (100 OKB stake, 24/7 uptime, slashing on a wrong
or timed-out call) are deliberately deferred until Kinetix has volume and
reputation on the platform. Disputes route through OKX's own arbitration —
Kinetix does not adjudicate disputes about its own verdicts.

## Services registered

| | Endpoint | Price |
|---|---|---|
| Paid | `POST /api/x402/verify/premium` | 1.00 USDC (x402, Base mainnet) |
| Free | `GET /api/v1/attestation/:receipt_id` | — |

The premium tier already carried the intended $1.00 price and the full feature
set (`all_scoring`, `ipfs_upload`, `erc8004_submission`), so no pricing changes
were needed. The `$KINETIX` discount tier is intentionally out of scope for this
listing.

`GET /api/x402/verify/:id/status` is also free and unregistered. It exists
because it is what closes the attestation lifecycle on this service — see
"Why the status route exists" below.

## Deployment: a second Railway service

The x402 server runs as its own Railway service off the same repo. `npm start`
runs the Telegram bot, so the paid endpoint needs a separate service with an
overridden start command. Process isolation is the point: a bot crash must not
take down a paid endpoint.

Configure in the Railway dashboard (no repo config — a root `railway.json`
would apply to both services):

- **Start command:** `npm run x402:start`
- **Health check path:** `/health`
- **Volume:** mounted at `/data`
- **Public domain:** generate one; this is the URL registered with OKX

### Environment variables

Boot-critical — the server exits or misbehaves without these:

| Var | Value | Why |
|---|---|---|
| `NETWORK_ID` | `base-mainnet` | Resolves chain 8453 → CDP facilitator |
| `DEFAULT_NETWORK` | `base_mainnet` | Must agree with `NETWORK_ID`; `utils/network.js` throws on a split |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | from CDP | Facilitator init failure exits the process |
| `CDP_WALLET_ADDRESS` | `0x8c61756f693A321777562433E19B2AabF71f5519` | This is `payTo` |
| `KINETIX_SIGNING_KEY` | signing private key | Needs the `0x` prefix |
| `DATA_DIR` | `/data` | The persistence knob that actually matters here |
| `NODE_ENV` | `production` | Arms the boot guard |
| `X402_TEST_MODE` | `false` | `true` bypasses payment entirely |
| `TESTNET_MODE` | `false` | Same |

Needed for premium features, exercised at scoring time: `BASE_MAINNET_RPC_URL`,
`PINATA_API_KEY`, `PINATA_SECRET_API_KEY`, `IPFS_GATEWAY`, the `ERC8004_*`
registry addresses, `KINETIX_ERC8004_TOKEN_ID`, `KINETIX_PUBLIC_KEY`.

Do **not** set: `ALLOW_EPHEMERAL_SIGNING_KEY` (would sign receipts with a
throwaway key), `TELEGRAM_BOT_TOKEN` (keeps the bot single-instance),
`X402_PORT` (let Railway's `$PORT` win), `FACILITATOR_URL` (dead — the code
reads `X402_FACILITATOR_URL`, and mainnet ignores both).

`WALLET_DATA` is **not** needed. It is read only by `wallet/agentkit.js`, which
is not in this service's require graph; `payTo` comes from the plain
`CDP_WALLET_ADDRESS` string. The historical CDP wallet-drift failure cannot
recur here.

### Verifying the deploy

Boot logs should show `✓ Data store at /data (boot #N)`, the correct `payTo`,
`eip155:8453`, and ERC-8004 token ID 16892. Redeploy once and confirm the boot
count **increments rather than resetting** — that is the proof the volume is
real. If `DATA_DIR` is unset the logs carry an explicit warning.

Then:

```bash
npm run okx:preflight -- https://<your-domain>
```

This asserts the 402 challenge an agent client actually parses, the free routes'
pass-through, the HTML-paywall branch, and the failure modes. It sends no
payment and broadcasts no transaction. Do not submit to OKX until it is green.

## Why the status route exists

Attestations are written by `scoreVerification`, which is driven by
`monitoring-service` in the **Telegram bot process** — a different Railway
service with a different volume, and Railway volumes cannot be shared. Without
a way to trigger scoring on this host, the registered free attestation endpoint
would return 404 for every id a reviewer tried.

`GET /api/x402/verify/:id/status` calls `getStatus()`, which triggers scoring
once the commitment window closes and writes the receipt to *this* service's
`DATA_DIR`. That closes the loop: pay → commitment → status → attestation, all
on one host.

**Before submitting**, seed a real receipt: run one paid premium verification
with a short `duration_days`, let it expire, hit the status route, then confirm
the attestation is retrievable from the free lookup. Hand that receipt id to the
reviewer.

## OKX review notes

OKX fails the **entire** submission if any single registered service
misbehaves. The exposed surface is four routes — premium POST, attestation GET,
status GET, `/health` — and each must return well-formed JSON on both success
and failure. Covered by `tests/x402-server.test.js` and the preflight script.

Server faults deliberately omit `error.message`: an ENOENT or RPC failure would
otherwise leak container paths to an anonymous caller.

## ASP profile description

> Kinetix is verification infrastructure for AI agents. It turns an agent's
> stated commitment — "post daily for 30 days," "respond within 10 minutes,"
> "ship by this deadline" — into an evidence-scored, cryptographically signed,
> on-chain attestation that any counterparty can independently check.
>
> The premium tier ($1.00 USDC via x402 on Base mainnet) covers the full
> verification suite: all three scoring models (consistency, quality,
> time-bound), IPFS pinning of the evidence bundle and receipt, and submission
> to the ERC-8004 Reputation Registry. Verification windows up to 90 days.
>
> Every receipt is EIP-712 signed and independently verifiable. Receipts are
> anchored as EAS attestations on Base under schema UID
> `0x4dae6f58d1879f9fcac21e45e22e3c3ce156b6ed56fbb2bbe3e5c7bde1178cff`
> (`string receiptId, bytes32 receiptHash, string verificationType, uint8
> score, string ipfsUri`) — readable at base.easscan.org without trusting
> Kinetix.
>
> **Verifiable identity:** Kinetix is registered in the ERC-8004 Identity
> Registry on Base mainnet as **token ID 16892**, controlled by
> `0x821a61d2C3E02446eD03285df1618639eF25D2b9`. Payments are received at
> `0x8c61756f693A321777562433E19B2AabF71f5519`. The OKX Agentic Wallet for this
> listing is a distinct TEE-generated key; ERC-8004 token 16892 and the EAS
> schema above are the canonical cross-venue identity anchors.
>
> Free endpoint: `GET /api/v1/attestation/{receipt_id}` returns any issued
> receipt with its signature, score breakdown, IPFS URI, and on-chain
> references — no payment required, so counterparties can audit outcomes before
> purchasing.
>
> Disputes are handled through OKX's arbitration process. Kinetix does not
> operate its own adjudication layer.

## Identity across venues

OKX's Agentic Wallet is generated inside a TEE at email signup. There is no key
import, so Kinetix ends up with a third address alongside the ERC-8004
controller and the CDP payment wallet. This is accepted rather than fought:
identity is cross-linked at the **metadata** level via ERC-8004 token 16892 and
the EAS schema UID, both named in the profile text above. Reuse this approach
for Virtuals ACP.

## Known follow-ups

- `config/erc8004/kinetix_metadata.json` is IPFS-pinned and stale: it
  advertises `https://kinetix-api.com/v1` with bearer auth and a `"5.00"` fee,
  none of which matches this listing. Not an OKX review blocker (OKX reads the
  profile, not IPFS), but it is the first dead end a counterparty following the
  token-16892 cross-link will hit. Re-pinning requires an on-chain
  `update-metadata-uri` transaction.
- Bazaar registration syncs at boot. If another x402 instance ever runs with the
  same `payTo`, expect duplicate or conflicting Bazaar entries.
