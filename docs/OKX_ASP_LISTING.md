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
| Paid | `POST /api/x402/verify/premium` | 1.00 USDC (x402, Base mainnet) **or** 1.00 USD₮0 (x402, X Layer) |
| Free | `GET /api/v1/attestation/:receipt_id` | — |

The 402 challenge on this endpoint declares **two** `accepts[]` options: X
Layer (`eip155:196`, settled via OKX's own facilitator) first, Base mainnet
(`eip155:8453`, settled via CDP) second. X Layer was added after OKX AI
rejected the first submission — its facilitator only settles on X Layer, so
that network must be present in the challenge. Base mainnet stays for
existing direct integrations; a caller picks whichever `accepts[]` entry it
can pay.

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
| `CDP_WALLET_ADDRESS` | `0x8c61756f693A321777562433E19B2AabF71f5519` | This is `payTo` for the Base leg |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | from the [OKX Developer Portal](https://web3.okx.com/onchainos/dev-portal) | Required for the X Layer leg — without these the boot guard refuses to start, since this URL is registered with OKX AI and its challenge must declare `eip155:196` |
| `KINETIX_SIGNING_KEY` | signing private key | Needs the `0x` prefix |
| `DATA_DIR` | `/data` | The persistence knob that actually matters here |
| `NODE_ENV` | `production` | Arms the boot guard |
| `X402_TEST_MODE` | `false` | `true` bypasses payment entirely |
| `TESTNET_MODE` | `false` | Same |

Needed for premium features, exercised at scoring time: `BASE_MAINNET_RPC_URL`,
`PINATA_API_KEY`, `PINATA_SECRET_API_KEY`, `IPFS_GATEWAY`,
`ERC8004_IDENTITY_BASE_MAINNET`, `ERC8004_REPUTATION_BASE_MAINNET`,
`KINETIX_ERC8004_TOKEN_ID`.

`X_LAYER_PAY_TO` is optional — it defaults to the OKX Agentic Wallet address
(`0x68fb2f902ecdff17f715ffa487a9eb94d2460f5e`) created for this listing. Only
set it explicitly if that wallet ever changes.

### OKX Developer Portal credentials

`OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` authenticate against OKX's
own x402 facilitator (`https://web3.okx.com/api/v6/pay/x402/*`) — separate
from, and unrelated to, the `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` pair used
for the Base-mainnet facilitator. Apply at
`https://web3.okx.com/onchainos/dev-portal`, then add the three values to the
Railway x402 service's environment (dashboard step — not committable). Without
them the service still runs, but only offers the Base-mainnet `accepts[]`
option, which is what got the first OKX submission rejected.

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

Also confirm `exact/eip155:196 supported: true` and `exact/eip155:8453
supported: true` — both printed right after `✓ Resource server initialized
with facilitator`. This is `resourceServer.getSupportedKind()` reporting what
each facilitator actually confirmed, so it proves the OKX credentials work
before any real caller hits the route — no payment involved.

Then:

```bash
npm run okx:preflight -- https://<your-domain>
```

This asserts the 402 challenge an agent client actually parses, the free routes'
pass-through, the HTML-paywall branch, and the failure modes. It sends no
payment and broadcasts no transaction. Do not submit to OKX until it is green.

## Required request fields

All three paid tiers require `platform` and `platform_handle` alongside the
commitment. The supported platform is **`clawstr`**, and the handle is the
agent's Nostr pubkey — either `npub1…` or 64-character hex. It is normalised to
hex before storage, because that is the form relays return in `event.pubkey`
and therefore the only form an author query can match.

`moltbook` is currently **not** accepted. Its collector queries a semantic text
search with no author filter, so any post merely mentioning a handle would count
as that agent's evidence; it will return once evidence can be attributed to a
single author.

This is enforced rather than optional because a commitment with no observable
platform is not merely unverified, it is *unverifiable*: nothing collects
evidence, so it scores 0/`failed` regardless of what the agent actually does.
`utils/monitoring-target.js` rejects those requests — and any malformed handle —
with a 400.

All request validation — the required-field checks above, platform/handle
resolution, and the commitment shape/range checks (`verification_type`,
`duration_days`, `minimum_actions`) — runs in an `app.post` handler mounted
*before* the x402 payment middleware, on every paid route. A request that
fails any of these checks gets a 400 immediately and never reaches the point
where a 402 payment challenge is issued, so an agent is never asked to sign a
payment authorization for a request that was going to be rejected. Only a
request that passes every check proceeds to the payment middleware, which
then behaves as usual (`@x402/express` skips settlement whenever the handler
responds `>= 400`, so a failure after payment is still never charged).

```json
{
  "agent_id": "example-agent-123",
  "commitment_description": "Post a daily build log for 30 days",
  "verification_type": "consistency",
  "platform": "clawstr",
  "platform_handle": "npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5",
  "criteria": { "duration_days": 30, "frequency": "daily", "minimum_actions": 30 }
}
```

`minimum_actions` is optional; when omitted it is derived from `duration_days`
and `frequency`, so a 30-day daily commitment targets 30 actions.

`criteria`'s shape depends on `verification_type` — the example above is the
`consistency` shape. The other two:

```json
{
  "agent_id": "example-agent-123",
  "commitment_description": "Respond to prompts within 30 minutes for two weeks",
  "verification_type": "quality",
  "platform": "clawstr",
  "platform_handle": "npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5",
  "criteria": {
    "duration_days": 14,
    "quality_metrics": { "response_time_minutes": 30, "minimum_length": 100 },
    "minimum_samples": 5
  }
}
```

```json
{
  "agent_id": "example-agent-123",
  "commitment_description": "Ship v2 API by three milestone deadlines",
  "verification_type": "time_bound",
  "platform": "clawstr",
  "platform_handle": "npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5",
  "criteria": {
    "milestones": [
      { "milestone_id": "design_spec", "description": "Design spec published", "deadline": "2026-09-01T00:00:00Z", "grace_period_hours": 12 },
      { "milestone_id": "beta_deploy", "description": "Beta deployed", "deadline": "2026-09-15T00:00:00Z", "grace_period_hours": 12 }
    ],
    "allow_early_completion": true,
    "penalty_per_late_hour": 1
  }
}
```

`quality` requires `quality_metrics` (an object — at least one of
`response_time_minutes`, `minimum_length`, `required_format`,
`satisfaction_threshold`, `technical_accuracy`) and `minimum_samples`.
`time_bound` requires a non-empty `milestones` array, each item needing at
least `milestone_id` and `deadline` (ISO 8601). Both are validated before the
payment challenge is issued, same as every other required field — see
`GET /api/v1/manifest` for the complete machine-readable schema per type.

`erc8004_token_id` is optional. Supplying it is what enables the on-chain
ERC-8004 reputation submission; without it that step is skipped.

A reviewer looking at the example receipt will see `onchain_status:
"skipped_not_registered"`. That is the honest terminal state for a recipient
with no EVM `wallet_address` and no ERC-8004 identity — there is no on-chain
agent to attach reputation to, and no wallet reconciliation could ever resolve
one from — which is what any Nostr-only agent gets. (A recipient who *does*
supply a wallet but simply isn't registered yet stays non-terminal instead:
reconciliation keeps retrying, since they may register later.) The receipt is
still signed, IPFS-pinned, and EAS-anchored regardless; only the ERC-8004 leg
does not apply.

`wallet_address` is optional and must be an EVM address. When present, it is
the recipient the on-chain EAS attestation names directly. When a Nostr-only
agent omits it, the receipt still gets an EAS anchor — the attestation is
recorded with the recipient field set to the zero address
(`eas.anchor_mode: "unattributed"`) rather than being skipped, so the
receiptHash, score, and IPFS URI are still independently verifiable on Base
mainnet at base.easscan.org without trusting Kinetix. Only the *identity* of
who is being attested to is missing in that case, never the attestation
itself.

## Why the status route exists

Attestations are written by `scoreVerification`, which is driven by
`monitoring-service`. That loop originally ran only in the **Telegram bot
process** — a different Railway service with a different volume, and Railway
volumes cannot be shared — so the registered free attestation endpoint would
have returned 404 for every id a reviewer tried. The loop now also runs in this
process; the status route below remains the way to force scoring on demand
rather than waiting for the next tick.

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
> Every receipt is signed with EIP-191 personal_sign over the keccak256 of its
> canonical sorted-key JSON, and states that scheme in
> `signatures.signature_scheme` so it can be reproduced without asking. Receipts are
> anchored as EAS attestations on Base under schema UID
> `0x4dae6f58d1879f9fcac21e45e22e3c3ce156b6ed56fbb2bbe3e5c7bde1178cff`
> (`string receiptId, bytes32 receiptHash, string verificationType, uint8
> score, string ipfsUri`) — readable at base.easscan.org without trusting
> Kinetix.
>
> **Verifiable identity:** Kinetix is registered in the ERC-8004 Identity
> Registry on Base mainnet as **token ID 16892**, controlled by
> `0x821a61d2C3E02446eD03285df1618639eF25D2b9`. Payments are received at
> `0x8c61756f693A321777562433E19B2AabF71f5519` on Base, or on X Layer at the
> OKX Agentic Wallet address for this listing — a distinct TEE-generated key;
> ERC-8004 token 16892 and the EAS schema above are the canonical cross-venue
> identity anchors regardless of which chain a given payment settles on.
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
