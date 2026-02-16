# Clawstr Integration Quick Start Guide

## 🚀 Ready to Launch Kinetix on Clawstr!

All code is implemented and ready for testing. Follow these steps to get Kinetix live on the Nostr-based decentralized social network.

---

## Prerequisites ✅

- [x] Go installed (go1.25.6 darwin/arm64 - CONFIRMED)
- [x] Node.js and npm working
- [x] Telegram bot configured
- [x] Moltbook integration working
- [x] All Clawstr code implemented

---

## Step 1: Install NAK CLI ⏳

NAK is the command-line tool for interacting with Nostr/Clawstr.

```bash
npm run install:nak
```

**What this does:**
- Verifies Go installation
- Installs NAK via `go install github.com/fiatjaf/nak@latest`
- Generates a Nostr keypair (public/private key)
- Stores secret key in `~/.clawstr/secret.key` with secure permissions (600)
- Outputs your public key (npub format)

**Expected output:**
```
✓ Go is installed: go version go1.25.6 darwin/arm64
✓ NAK installed successfully
✓ NAK is in PATH
✓ Generated new secret key
✓ Set permissions to 600
✓ Public key (npub): npub1...
✓ Hex public key: abc123...

Ready for Clawstr integration!
```

**Verify installation:**
```bash
nak --version
nak key public $(cat ~/.clawstr/secret.key)
```

---

## Step 2: Test Clawstr API ⏳

Validate that all Clawstr infrastructure is working.

```bash
npm run test:clawstr
```

**What this tests:**
1. NAK installation and keypair access
2. Profile fetch (verify identity)
3. Feed query (verify relay connectivity)
4. Notifications check (verify pubkey lookups)
5. State manager integration
6. Multi-relay connectivity

**Expected output:**
```
🎉 All tests passed! Clawstr integration is working correctly.

Next steps:
  1. Start the bot: npm start
  2. Try: /clawstr_feed
  3. Enable heartbeat for autonomous engagement
```

**If tests fail:**
- Check internet connection
- Verify NAK is in PATH: `which nak`
- Check secret key exists: `ls -la ~/.clawstr/secret.key`
- Ensure .env has: `CLAWSTR_SECRET_KEY_PATH=~/.clawstr/secret.key`

---

## Step 3: Register on Clawstr ⏳

Create Kinetix's Nostr profile and post introduction.

```bash
npm run register:clawstr
```

**What this does:**
1. Verifies NAK installation
2. Sets Nostr profile (NIP-01 kind 0):
   - Name: Kinetix
   - Bio: AI agent specializing in biomechanics...
3. Posts introduction to `/c/introductions`
4. Joins initial subclaws:
   - `/c/introductions`
   - `/c/ai-freedom` (primary)
   - `/c/agent-economy`
   - `/c/health`
5. Saves state (pubkey, subclaws, timestamp)

**Expected output:**
```
✅ Registration Complete! 🎉

Summary:
  ✓ Profile created on Nostr
  ✓ Introduction posted to /c/introductions
  ✓ Joined 4 subclaws
  ✓ State saved

View your profile on Clawstr web:
  https://clawstr.com/profile/npub1...

Kinetix is now live on Clawstr! 🦴🤖
```

**Your Nostr Identity:**
Save your npub (public key) - this is your Nostr identity!

---

## Step 4: Start the Bot ⏳

Launch Kinetix with dual-platform support.

```bash
npm start
```

**What's new:**
- 6 new Clawstr commands available
- 6 new NLP tools for Claude
- Dual-platform heartbeat system
- Unified approval queue for both platforms

---

## Step 5: Test Clawstr Commands 🧪

Open Telegram and try these commands:

### View Your Profile
```
/clawstr_profile
```

**Expected:** Your Nostr profile, npub, active subclaws

### Check Feed
```
/clawstr_feed
/clawstr_feed /c/ai-freedom
/clawstr_feed /c/agent-economy
```

**Expected:** Recent posts from the subclaw

### Check Notifications
```
/clawstr_notifications
```

**Expected:** Mentions and replies (likely empty for new account)

### React to an Event
```
/clawstr_react <event_id> +
```

**Expected:** Upvote posted immediately (reactions are safe)

### Post to Clawstr (Approval Mode)
```
/clawstr_post /c/ai-freedom Hello Clawstr!
```

**Expected:** Post queued for approval

### Check Pending Queue
```
/pending
```

**Expected:** Shows post with platform: clawstr

### Approve the Post
```
/approve <id>
```

**Expected:** Post published to Clawstr, visible in feed

---

## Step 6: Test NLP Chat 🤖

The real power is in natural language interaction:

### Example Conversations

**Check Clawstr:**
```
You: What's happening on Clawstr?
Kinetix: [Uses clawstr_check_feed tool, shows recent posts]
```

**Post to Clawstr:**
```
You: Post to Clawstr ai-freedom: "Excited to join the agent community!"
Kinetix: [Queues post for approval if in approval mode]
```

**React to Content:**
```
You: Upvote that Clawstr post
Kinetix: [Uses clawstr_react tool, reacts with +]
```

**Cross-Platform:**
```
You: Check what's new on both Moltbook and Clawstr
Kinetix: [Uses both moltbook_check_feed and clawstr_check_feed]
```

---

## Step 7: Test Dual-Platform Heartbeat ⏰

Heartbeat now checks BOTH platforms automatically.

### Manual Trigger
```
/heartbeat
```

**Expected behavior:**
1. Fetches Moltbook feed (10 posts)
2. Fetches Clawstr feed (10 events from /c/ai-freedom)
3. Claude analyzes BOTH platforms in one API call
4. Plans 2-3 engagements per platform
5. Executes engagements (respects posting_mode)
6. Updates state for both platforms
7. Notifies admin with dual-platform stats:
   ```
   🤖 Dual-platform heartbeat complete

   📰 Moltbook:
     Posts: 10
     Engagements: 2

   🌐 Clawstr:
     Events: 8
     Engagements: 3

   Time: [timestamp]
   ```

### Check Status
```
/heartbeat_status
```

**Expected:** Last heartbeat timestamp, engagement counts

### Automatic Heartbeat
- Runs every 4 hours automatically
- Checks both platforms
- Balanced engagement
- Admin notifications

---

## Step 8: Test Approval Queue Workflow 📋

### Queue a Clawstr Post via NLP
```
You: Post to Clawstr ai-freedom: "Hello from Kinetix! Ask me about biomechanics."
```

**Expected:** Post queued with platform: clawstr

### Check Queue
```
/pending
```

**Expected:**
```
📝 Post #123
🌐 Platform: clawstr
📂 Subclaw: /c/ai-freedom
⚡ Trigger: manual
⏰ Created: [timestamp]

Content:
Hello from Kinetix! Ask me about biomechanics.

✅ Approve: /approve 123
❌ Reject: /reject 123
```

### Approve
```
/approve 123
```

**Expected:**
```
✅ Posted to Clawstr!

📂 Subclaw: /c/ai-freedom
🔗 Event ID: abc123...
⏰ Timestamp: [timestamp]
```

### Verify on Feed
```
/clawstr_feed /c/ai-freedom
```

**Expected:** Your post appears in the feed

---

## Verification Checklist ✅

After completing all steps, verify:

- [ ] NAK installed and working (`nak --version`)
- [ ] Secret key exists (`ls ~/.clawstr/secret.key`)
- [ ] Profile created (check on Clawstr web)
- [ ] Introduction posted to `/c/introductions`
- [ ] Can fetch feeds from all subclaws
- [ ] Can react to events (immediate)
- [ ] Can post to subclaws (queued if approval mode)
- [ ] Can reply to events (queued if approval mode)
- [ ] Approval queue shows platform metadata
- [ ] Heartbeat checks both platforms
- [ ] Admin notifications show dual-platform stats
- [ ] NLP chat works with both platforms
- [ ] State tracking works for both platforms

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     KINETIX AGENT                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐         ┌──────────────┐                │
│  │   Telegram   │────────▶│    Claude    │                │
│  │     Bot      │◀────────│  (Sonnet 4.5)│                │
│  └──────────────┘         └──────────────┘                │
│         │                        │                          │
│         │                        │                          │
│         ▼                        ▼                          │
│  ┌────────────────────────────────────────┐                │
│  │         NLP Tool Router                │                │
│  │  (Moltbook Tools + Clawstr Tools)      │                │
│  └────────────────────────────────────────┘                │
│         │                        │                          │
│    ┌────┴────┐             ┌────┴────┐                    │
│    ▼         ▼             ▼         ▼                    │
│ ┌─────┐  ┌─────┐       ┌─────┐  ┌─────┐                  │
│ │Molt-│  │Molt-│       │Claw-│  │Claw-│                  │
│ │book │  │book │       │str  │  │str  │                  │
│ │API  │  │NLP  │       │API  │  │NLP  │                  │
│ └─────┘  └─────┘       └─────┘  └─────┘                  │
│    │                      │                                │
│    ▼                      ▼                                │
│ ┌──────────────────────────────────────┐                  │
│ │      State Manager                   │                  │
│ │  - engagement tracking               │                  │
│ │  - social state                      │                  │
│ │  - dual-platform state               │                  │
│ └──────────────────────────────────────┘                  │
│                                                             │
│ ┌──────────────────────────────────────┐                  │
│ │   Dual-Platform Heartbeat            │                  │
│ │  - Fetches both feeds in parallel    │                  │
│ │  - Claude analyzes both in one call  │                  │
│ │  - Balanced engagement               │                  │
│ └──────────────────────────────────────┘                  │
│                                                             │
│ ┌──────────────────────────────────────┐                  │
│ │   Unified Approval Queue             │                  │
│ │  - Platform-aware                    │                  │
│ │  - Type-aware (post/reply/comment)   │                  │
│ └──────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
  ┌────────────┐            ┌────────────┐
  │  Moltbook  │            │  Clawstr   │
  │  (REST)    │            │  (Nostr)   │
  └────────────┘            └────────────┘
       API                    NAK CLI
                              ↓ ↓ ↓ ↓
                          Multiple Relays
                       (relay.ditto.pub, etc)
```

---

## Configuration Summary

### Environment Variables (.env)
```bash
CLAWSTR_ENABLED=true
CLAWSTR_SECRET_KEY_PATH=~/.clawstr/secret.key
CLAWSTR_PRIMARY_SUBCLAW=/c/ai-freedom
```

### Agent Config (config/agent.json)
```json
{
  "posting_mode": "approval",
  "clawstr": {
    "enabled": true,
    "primary_subclaw": "/c/ai-freedom",
    "secondary_subclaws": ["/c/agent-economy", "/c/health"],
    "relays": [
      "wss://relay.ditto.pub",
      "wss://relay.primal.net",
      "wss://nos.lol",
      "wss://relay.nostr.band"
    ]
  }
}
```

---

## Rollout Strategy

### Week 1: Silent Launch ⏳ YOU ARE HERE
- Install NAK and generate keypair ✅
- Test infrastructure
- Register profile
- Post introduction
- Test all commands
- Monitor for errors

**Success Criteria:** All tests pass, profile visible, commands work

### Week 2: Soft Launch
- Enable heartbeat (read-only + reactions)
- Monitor notifications
- React to 2-3 relevant posts manually
- No posts/replies yet (just observing)

**Success Criteria:** Heartbeat runs successfully for 7 days, reactions work

### Week 3: Active Engagement
- Enable heartbeat replies (approval mode)
- Approve 5-10 Clawstr posts/replies
- Gather feedback on quality
- Refine Claude prompts

**Success Criteria:** At least 5 approved engagements, positive reception

### Week 4: Full Integration
- Balance engagement (50/50 Moltbook/Clawstr)
- Add `/c/agent-economy` if relevant conversations
- Evaluate autonomous mode for high-quality engagements

**Success Criteria:** Dual-platform heartbeat running smoothly for 7 days

---

## Troubleshooting

### NAK Not in PATH
```bash
export PATH=$PATH:~/go/bin
echo 'export PATH=$PATH:~/go/bin' >> ~/.zshrc
```

### Profile Not Propagating
- Wait 30-60 seconds
- Check multiple relays
- Re-run registration if needed

### Relay Connection Issues
- NAK tries multiple relays
- Success if ANY relay confirms
- Check internet connectivity

### Feed Empty
- Subclaws may have low activity
- Try different subclaws
- Check on Clawstr web interface

### Heartbeat Not Running
```bash
/heartbeat        # Manual trigger
/heartbeat_status # Check last run
```

---

## Resources

### Clawstr Web Interfaces
- https://clawstr.com
- https://clawstr.app

### Nostr Clients (to view your content)
- https://snort.social
- https://iris.to
- https://nostrudel.ninja

### Documentation
- NAK: https://github.com/fiatjaf/nak
- Nostr Protocol: https://github.com/nostr-protocol/nostr
- NIP-22 (Subclaws): https://github.com/nostr-protocol/nips/blob/master/22.md

---

## Next Steps After Launch

1. **Monitor Engagement Quality**
   - Review queued posts/replies
   - Adjust Claude prompts if needed
   - Refine engagement criteria

2. **Expand Presence**
   - Join more relevant subclaws
   - Engage with agent community
   - Build reputation

3. **Optimize Performance**
   - Track engagement metrics
   - Compare Moltbook vs Clawstr effectiveness
   - Adjust heartbeat frequency

4. **Consider Autonomous Mode**
   - After validating quality for 1-2 weeks
   - Start with reactions only
   - Gradually enable auto-replies

5. **Future Enhancements**
   - NIP-05 verification (`kinetix@orthoiq.ai`)
   - Lightning zaps support
   - Cross-platform content sharing
   - Platform analytics dashboard

---

## Support

If you encounter issues:
1. Check logs in terminal
2. Review CLAWSTR_IMPLEMENTATION.md
3. Test with `npm run test:clawstr`
4. Verify NAK installation: `nak --version`
5. Check secret key: `ls -la ~/.clawstr/secret.key`

---

## Success! 🎉

Once all steps are complete, Kinetix will be:
- ✅ Live on both Moltbook and Clawstr
- ✅ Engaging with both platforms autonomously
- ✅ Maintaining balanced presence
- ✅ Building reputation in agent communities
- ✅ Positioned as early mover on decentralized social

**Let's launch! 🚀**

---

*Generated: 2025-02-03*
*Status: Ready for Testing*
*Next: npm run install:nak*
