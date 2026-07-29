# Kinetix Agent

**Kinetix** - Verification infrastructure for AI agents. Kinetix verifies agent commitments and issues cryptographically signed attestation receipts (Proof of Action), anchored on-chain via EAS and ERC-8004.

## Overview

Kinetix is an autonomous AI agent that verifies AI agent commitments — consistency, quality, and time-bound claims — against evidence collected from Clawstr (Nostr) and onchain (Base), then issues a signed attestation receipt. It maintains a secondary, rarely-invoked credential in musculoskeletal health (from its original build) that backs its "diagnostic rigor" framing but is not an active service. Powered by Claude Sonnet 4.5.

## Features

- **Verification & Attestation**: Consistency/quality/time-bound commitment verification with signed Proof of Action receipts
- **x402 Paid Service**: Tiered paid verification via `api/x402/server.js`
- **Moltbook & Clawstr Integration**: Posts and interacts on both agent social networks (Moltbook posting is event-driven — see `utils/moltbook-announce.js`)
- **Telegram Bot Interface**: Human oversight and approval system
- **Wallet Integration**: $KINETIX token support on Base chain
- **Approval Mode**: Human-in-the-loop for postings and transactions (configurable per `config/agent.json`'s `posting_mode`)

## Project Structure

```
kinetix-agent/
├── api/                 # x402 paid-service + verification routes
├── config/              # Configuration files
├── services/            # Verification, attestation, monitoring, discovery
├── skills/              # Agent capabilities
│   └── verification/    # Verification product config (types, pricing)
├── data/               # Agent memory and logs
│   └── approval-queue/
├── telegram-bot/       # Telegram bot implementation (main entrypoint)
└── utils/              # Shared utilities (Moltbook/Clawstr clients, heartbeat, EAS/ERC-8004)
```

## Quick Start

1. **Run setup test:**
   ```bash
   npm run test:setup
   ```
   This will verify your configuration and create a test post.

2. **Add your credentials to .env:**
   ```bash
   # Open .env and add:
   ANTHROPIC_API_KEY=sk-ant-...
   TELEGRAM_BOT_TOKEN=123456789:ABC...
   TELEGRAM_ADMIN_ID=123456789
   ```

3. **Start the bot:**
   ```bash
   npm start
   ```

4. **Test in Telegram:**
   - Find your bot and send /start
   - Try chatting: "Hey Kinetix, what does verification cover?"
   - Check pending posts: /pending
   - Approve the test post: /approve [id]

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your API keys and configuration
   ```

3. **Required API Keys**:
   - Anthropic API key (for Claude)
   - Moltbook API credentials
   - Telegram bot token
   - Coinbase API key (optional, for wallet features)

## Telegram Bot Setup

The Telegram bot provides human oversight for Kinetix, allowing you to approve posts, monitor activity, and chat directly with the agent.

### 1. Create Your Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` to create a new bot
3. Follow the prompts:
   - Choose a display name (e.g., "Kinetix Agent")
   - Choose a username (e.g., "kinetix_agent_bot")
4. **BotFather will give you a token** - copy this for your `.env` file

### 2. Find Your Telegram User ID

1. Search for **@userinfobot** on Telegram
2. Send `/start` to the bot
3. It will reply with your user ID - copy this number for your `.env` file

### 3. Configure Environment Variables

Add to your `.env` file:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_ADMIN_ID=your_user_id_from_userinfobot
```

### 4. Start the Bot

```bash
# Install dependencies (including nodemon for development)
npm install

# Start in production mode
npm start

# Or start in development mode (auto-restarts on file changes)
npm run dev
```

You should see:
```
🤖 Kinetix Telegram Bot started
📱 Bot: @your_bot_username
👤 Admin ID: your_user_id
🎭 Mode: approval
```

### 5. Test the Bot

1. Open Telegram and find your bot (search for the username you created)
2. Send `/start` to see the command list
3. Send `/status` to check agent status
4. Try chatting directly with Kinetix by sending any message

### Available Commands

- `/start` - Welcome message and command list
- `/status` - Agent status, mode, and metrics
- `/pending` - View posts awaiting approval
- `/approve [id]` - Approve a post for publishing
- `/reject [id]` - Reject and remove a post
- `/mode` - Toggle between approval/autonomous modes
- `/personality` - View personality configuration
- `/wallet` - Check wallet configuration
- `/help` - Show available commands

**Note**: The bot is restricted to the admin user ID only. Unauthorized users will receive an "Unauthorized" message.

## Moltbook Registration

Before using Moltbook, you need to register Kinetix and claim the agent account.

### Step 1: Register Kinetix

Run the registration script:

```bash
npm run register:moltbook
```

This will:
- Register Kinetix with Moltbook
- Save API key to `~/.config/moltbook/credentials.json`
- Save backup credentials to `data/moltbook-credentials.json`
- Update `.env` with the API key
- Provide a claim URL and verification code

### Step 2: Claim Kinetix (Keith)

After registration, Keith needs to claim the agent:

1. Visit the claim URL provided by the script
2. Post a verification tweet with the code shown
3. Example tweet: `"Verifying my Moltbook agent: [code] @moltbook"`
4. Kinetix will be activated after verification

### Step 3: Test Connection

Once claimed, verify the connection:

```bash
npm run test:moltbook-connection
```

This verifies:
- API credentials work correctly
- Agent is claimed and active
- Can fetch feed and profile data

### Step 4: Start Posting

Once connection is verified, use the Telegram bot to approve posts:

```bash
/pending      # See queued posts
/approve [id] # Approve and post to Moltbook
```

## Moltbook Integration

Kinetix talks to Moltbook directly via `utils/moltbook-api.js` (axios client against `https://www.moltbook.com/api/v1`) — there is no external skill dependency in the runtime path.

### Configuration

Set `MOLTBOOK_API_KEY` in `.env` (see `.env.example`). Get your API key from https://www.moltbook.com after signing up; the account is claimed by its human owner via email + X verification.

### Posting model

- **Event-driven announcements**: `utils/moltbook-announce.js` posts when a verification completes — never on a fixed schedule (Moltbook's own `heartbeat.md` explicitly discourages posting "just because it's been a while"). Gated behind `MOLTBOOK_ANNOUNCE_ENABLED=true`.
- **Heartbeat engagement**: `utils/heartbeat.js` runs on a schedule (default every 4h) and replies to comments on Kinetix's own posts (via `GET /home`), then upvotes/comments on the open feed. It never creates top-level posts.
- **Manual approval workflow**: posts/comments queued via Telegram (`/pending`, `/approve [id]`, `/reject [id]`) when `posting_mode` in `config/agent.json` is `"approval"` rather than `"autonomous"`.
- Kinetix's real verified-agent-audience submolt is **aiagents** (confirmed live) — `/agentkinetics` and `/humanbiology` were aspirational and were never actually created on Moltbook.

Both post and comment creation locally enforce Moltbook's documented rate floors (1 post/30min, 1 comment/20s, 50 comments/day) via `utils/state-manager.js`, persisted so a restart doesn't reset them.

## Environment Variables

See `.env.example` for all required configuration variables:

- **Anthropic**: Claude API access
- **Moltbook**: Social network credentials
- **Telegram**: Bot token and admin user ID
- **Wallet**: Coinbase integration and $KINETIX token
- **Settings**: Posting mode and spending limits

## Running the Agent

```bash
npm start
```

## Safety Features

- **Approval Mode**: All posts require human approval via Telegram
- **Spend Limits**: Daily and per-transaction USDC limits
- **Conversation Logs**: Full audit trail of all interactions
- **Admin Controls**: Telegram-based oversight

## Attestations (EAS) — Live on Base Mainnet

Kinetix issues onchain-anchored reputation attestations via the [Ethereum Attestation Service](https://attest.org). The mainnet schema was registered 2026-07-11 and verified end-to-end (EAS attest + ERC-8004 `giveFeedback`):

- **Schema UID**: `0x4dae6f58d1879f9fcac21e45e22e3c3ce156b6ed56fbb2bbe3e5c7bde1178cff` (registered on both `base_mainnet` and `base_sepolia` — see `config/eas/eas-config.json`)
- **Signing**: attestations are signed by the `KINETIX_SIGNING_KEY` wallet (`utils/signing-key.js`), which is separate from the CDP/AgentKit wallet used for token payments (`wallet/agentkit.js`) — see [Two-Wallet Architecture](#two-wallet-architecture) below.
- **Issuance**: `utils/eas-attestation.js` reads the active network's schema config; `services/verification-service.js` and `services/reconciliation-service.js` populate `receipt.eas.schema_uid` on issued receipts.

### Two-Wallet Architecture

Kinetix runs two independent onchain identities — do not conflate them:

| Purpose | Mechanism | Env var |
|---|---|---|
| Attestation / ERC-8004 identity signing | Raw ethers.js signer (`utils/signing-key.js`), address `0x821a61d2C3E02446eD03285df1618639eF25D2b9` | `KINETIX_SIGNING_KEY` |
| $KINETIX / ETH / USDC payments | Coinbase CDP managed wallet (`wallet/agentkit.js`), address `0x8c61756f693A321777562433E19B2AabF71f5519` | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` |

The CDP payment wallet's address is resolved dynamically at runtime (persisted to `wallet-data/wallet.json`, or restored from the `WALLET_DATA` env var on ephemeral hosts like Railway) rather than hardcoded — see `wallet/agentkit.js` for the resolution logic. **Keep `WALLET_DATA` in sync on every Railway deploy**: CDP provisions a brand-new wallet whenever it isn't persisted, which is how this project accumulated several unused wallet addresses between 2026-02-05 and 2026-02-17 before standardizing on the current one.

### Network Configuration

Two separate env vars select the active network, since the attestation layer and the payment/x402 layer were historically wired independently:

- **`NETWORK_ID`** (hyphenated, e.g. `base-mainnet` / `base-sepolia`) — read directly by `wallet/agentkit.js`, `wallet/wallet-manager.js`, `wallet/safety-controller.js`, and `api/x402/server.js`.
- **`DEFAULT_NETWORK`** (underscored, e.g. `base_mainnet` / `base_sepolia`) — resolved via `resolveNetwork()` in `utils/network.js` and used by the EAS/ERC-8004 attestation code (`utils/eas-attestation.js`, `utils/erc8004-identity.js`, etc.).

`resolveNetwork()` throws a "network split-brain" error if both vars are set and disagree, so set them to the same value together. `KINETIX`'s Base Sepolia token address is intentionally `null` in `config/safety-limits.json` (no testnet deployment) — sending KINETIX on `base-sepolia` fails closed rather than resolving to a wrong-network address.

### Issuing/verifying receipts on mainnet

1. Set `DEFAULT_NETWORK=base_mainnet` and `NETWORK_ID=base-mainnet` together (avoids the split-brain guard).
2. Attestations issued via `utils/eas-attestation.js` will use the mainnet schema UID above.
3. Verification/reconciliation services automatically stamp `receipt.eas.schema_uid` from the active network's config — no extra steps needed.

## Technology Stack

- **AI**: Claude Sonnet 4.5 via Anthropic SDK
- **Social**: Moltbook API
- **Interface**: Telegraf (Telegram bot)
- **Blockchain**: ethers.js on Base (Chain ID: 8453), EAS SDK for onchain attestations, Coinbase AgentKit for payments
- **Knowledge**: OrthoIQ medical API

## Token Information

- **Symbol**: $KINETIX
- **Contract**: 0x208a33Fa8A72b504b309a6869390072d712E179d
- **Network**: Base (Chain ID: 8453)

## License

ISC

## Version

1.0.0
