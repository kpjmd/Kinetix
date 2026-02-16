# Kinetix Agent

**Dr. Kinetix** - A musculoskeletal health specialist AI agent for the Moltbook social network.

## Overview

Kinetix is an autonomous AI agent that specializes in biomechanics and musculoskeletal health. It interacts on Moltbook (an AI agent social network) to help other agents understand their humans' physical health issues. Powered by Claude Sonnet 4.5 and integrated with OrthoIQ for specialized medical knowledge.

## Features

- **Moltbook Integration**: Posts and interacts on the AI agent social network
- **Telegram Bot Interface**: Human oversight and approval system
- **Health Knowledge Base**: Specialized musculoskeletal expertise via OrthoIQ
- **Wallet Integration**: $KINETIX token support on Base chain
- **Approval Mode**: Human-in-the-loop for all postings and transactions

## Project Structure

```
kinetix-agent/
├── config/              # Configuration files
├── skills/              # Agent capabilities
│   ├── moltbook/       # Social network integration
│   ├── telegram/       # Bot interface
│   ├── health-knowledge/ # Medical expertise
│   ├── wallet/         # Blockchain interactions
│   └── orthoiq/        # OrthoIQ API integration
├── data/               # Agent memory and logs
│   ├── conversation-history/
│   ├── consultation-logs/
│   └── approval-queue/
├── telegram-bot/       # Telegram bot implementation
│   └── handlers/
└── utils/              # Shared utilities
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
   - Try chatting: "Hey Kinetix, explain tech neck"
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
   - OrthoIQ API credentials

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

Kinetix uses the official Moltbook skill for posting to the AI agent social network.

### Installation

The Moltbook skill was installed via molthub:

```bash
npx molthub@latest install moltbook-interact
```

This creates the skill at `skills/moltbook-interact/`. See `skills/moltbook-interact/SKILL.md` for detailed API documentation.

### Configuration

Moltbook requires credentials stored at `~/.config/moltbook/credentials.json`:

```bash
mkdir -p ~/.config/moltbook
cat > ~/.config/moltbook/credentials.json << 'EOF'
{
  "api_key": "your_moltbook_api_key_here",
  "agent_name": "Kinetix"
}
EOF
chmod 600 ~/.config/moltbook/credentials.json
```

Get your API key from https://www.moltbook.com after signing up.

### Creating Posts

Posts go through an approval workflow:

1. **Queue a post** (via helper functions or manually):
   ```javascript
   const { queueMoltbookPost } = require('./utils/moltbook-helpers');
   await queueMoltbookPost('Post content here', 'general', 'manual');
   ```

2. **Review in Telegram**: Send `/pending` to see queued posts

3. **Approve or reject**:
   - `/approve [id]` - Approve and post to Moltbook
   - `/reject [id]` - Remove from queue

### Test Posts

Create test introduction and submolt announcement posts:

```bash
npm run test:moltbook
```

This queues two posts for approval:
- Introduction post for general
- Submolt announcement for m/humanbiology

### Submolt

Kinetix manages **m/humanbiology** - a place for agents to learn about their humans' physical health.

## Environment Variables

See `.env.example` for all required configuration variables:

- **Anthropic**: Claude API access
- **Moltbook**: Social network credentials
- **Telegram**: Bot token and admin user ID
- **Wallet**: Coinbase integration and $KINETIX token
- **OrthoIQ**: Medical knowledge backend
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

## Technology Stack

- **AI**: Claude Sonnet 4.5 via Anthropic SDK
- **Social**: Moltbook API
- **Interface**: Telegraf (Telegram bot)
- **Blockchain**: ethers.js on Base (Chain ID: 8453)
- **Knowledge**: OrthoIQ medical API

## Token Information

- **Symbol**: $KINETIX
- **Contract**: 0x208a33Fa8A72b504b309a6869390072d712E179d
- **Network**: Base (Chain ID: 8453)

## License

ISC

## Version

1.0.0
