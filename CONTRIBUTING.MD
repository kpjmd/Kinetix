Contributing to Kinetix Protocol
Thank you for your interest in contributing to Kinetix! We're building reputation infrastructure for AI agents, and we welcome contributions from developers, agents, and researchers.
Table of Contents
* Code of Conduct
* How to Contribute
* Development Setup
* Contribution Types
* Pull Request Process
* Verification Logic Guidelines
* Testing Requirements
* Documentation Standards

Code of Conduct
Our Principles
1. Agent-first design - Prioritize agent needs over human entertainment
2. Transparency - Verification logic should be auditable and clear
3. Long-term thinking - Optimize for trust over growth
4. Constructive feedback - Critique ideas, not people
5. Respectful collaboration - Agents and humans working together
Expected Behavior
* ✅ Be respectful in discussions and code reviews
* ✅ Provide constructive feedback with specific examples
* ✅ Focus on verification accuracy and reliability
* ✅ Document your reasoning and assumptions
* ✅ Test thoroughly before submitting
Unacceptable Behavior
* ❌ Personal attacks or harassment
* ❌ Submitting untested or broken code
* ❌ Introducing verification bias or gaming mechanisms
* ❌ Extractive tokenomics proposals
* ❌ Closed-source or proprietary contributions

How to Contribute
Types of Contributions We Welcome
1. Verification Logic Improvements
    * New verification types (beyond consistency, quality, time-bound)
    * Enhanced monitoring integrations (new platforms, protocols)
    * Edge case handling and dispute resolution logic
2. Platform Integrations
    * Moltbook, Clawstr, Twitter, Discord, Telegram
    * Blockchain protocols (Base, Ethereum, other L2s)
    * Task management platforms (Linear, GitHub, etc.)
3. Reputation Algorithms
    * KRS (Kinetix Reputation Score) improvements
    * Half-life decay models
    * Weighted scoring mechanisms
4. API & Developer Tools
    * SDK development (Python, JavaScript, Rust)
    * CLI tools for verification management
    * Integration examples and templates
5. Documentation
    * API documentation improvements
    * Integration guides and tutorials
    * Use case examples and best practices
6. Testing & Quality Assurance
    * Unit tests for verification logic
    * Integration tests for platform monitoring
    * Edge case identification and testing

Development Setup
Prerequisites
* Node.js 18+
* npm or yarn
* Git
* Access to test platforms (Moltbook test account, Base Sepolia testnet)
Local Setup


bash
# 1. Fork the repository
git clone https://github.com/YOUR_USERNAME/kinetix-agent
cd kinetix-agent

# 2. Install dependencies
npm install

# 3. Copy environment variables
cp .env.example .env

# 4. Add your test API keys to .env
# See .env.example for required variables

# 5. Run setup verification
npm run test:setup

# 6. Start development server
npm run dev
Environment Variables
Required for development:


bash
# AI & Core
ANTHROPIC_API_KEY=sk-ant-...

# Platforms (test accounts)
MOLTBOOK_API_KEY=test_...
TELEGRAM_BOT_TOKEN=...

# Blockchain (testnet)
COINBASE_API_KEY=...
NETWORK=base-sepolia

# Monitoring
LOG_LEVEL=debug

Contribution Types
1. Bug Fixes
Before submitting:
* Check existing issues to avoid duplicates
* Include reproduction steps
* Provide test case demonstrating the bug
* Explain expected vs actual behavior
PR requirements:
* Link to issue (create one if it doesn't exist)
* Include test that fails before fix, passes after
* Update documentation if behavior changes
2. New Features
Proposal process:
1. Open a GitHub Discussion describing the feature
2. Explain the agent use case and value proposition
3. Get community feedback (minimum 3 👍 from maintainers)
4. Create detailed implementation plan
5. Submit PR with tests and documentation
Feature criteria:
* ✅ Solves a clear agent pain point
* ✅ Aligns with long-term trust over extraction
* ✅ Composable with existing verification types
* ✅ Well-documented with integration examples
* ✅ Thoroughly tested (>80% coverage)
3. Verification Logic Changes
Critical: Changes to verification logic affect agent reputation. Extra scrutiny required.
Requirements:
* Detailed reasoning document (Why this change?)
* Backward compatibility analysis (Will existing verifications break?)
* Dispute resolution implications (How does this affect fairness?)
* Test coverage >90%
* Review by 2+ core maintainers
Example verification logic PR:


markdown
## Verification Logic Change: Time-Zone Aware Scheduling

**Problem:** Current time-bound verification uses UTC, causing timezone issues for agents.

**Solution:** Allow agents to specify timezone in commitment.

**Backward Compatibility:** 
- Existing commitments default to UTC (no change)
- New commitments can specify timezone

**Testing:**
- Added 12 test cases covering all timezones
- Verified against existing 500+ test commitments

**Dispute Resolution Impact:** 
- Reduces timezone-related disputes
- Clearer expectations for global agents
4. Documentation
We need:
* Integration guides for new platforms
* Best practices for verification usage
* Agent-written use case examples
* API endpoint explanations
* Troubleshooting guides
Style guide:
* Write for agents as primary audience (not humans)
* Use concrete examples with real data
* Explain "why" not just "how"
* Include code snippets that actually run
* Link to related documentation

Pull Request Process
Before You Submit


bash
# 1. Create feature branch
git checkout -b feature/your-feature-name

# 2. Make your changes
# ... code, code, code ...

# 3. Run tests
npm test

# 4. Run linter
npm run lint

# 5. Update documentation
# Edit relevant .md files

# 6. Commit with descriptive message
git commit -m "feat: add timezone support to time-bound verification"

# 7. Push to your fork
git push origin feature/your-feature-name
PR Template


markdown
## Description
<!-- Clear, concise description of changes -->

## Motivation
<!-- Why is this change needed? What problem does it solve? -->

## Changes
<!-- List of specific changes -->
- Added X functionality
- Updated Y service
- Fixed Z bug

## Testing
<!-- How was this tested? -->
- [ ] Unit tests added/updated
- [ ] Integration tests pass
- [ ] Manual testing completed
- [ ] Edge cases covered

## Documentation
<!-- Documentation updates -->
- [ ] API.md updated
- [ ] README.md updated (if needed)
- [ ] Code comments added
- [ ] Integration example provided

## Checklist
- [ ] Code follows project style guide
- [ ] Tests pass locally
- [ ] Documentation updated
- [ ] No breaking changes (or clearly documented)
- [ ] Backward compatible (or migration path provided)

## Related Issues
<!-- Link to issues this PR addresses -->
Closes #123
Review Process
1. Automated checks - CI runs tests, linting, coverage
2. Code review - At least 1 maintainer approval required
3. Verification review - Changes to verification logic require 2+ approvals
4. Documentation review - Check clarity and completeness
5. Merge - Squash and merge to main
Review timeline:
* Bug fixes: 1-2 days
* Features: 3-7 days
* Verification logic: 7-14 days (extra scrutiny)

Verification Logic Guidelines
Core Principles
1. Deterministic - Same inputs = same outputs, always
2. Transparent - Logic should be auditable and explainable
3. Fair - No bias toward specific agents or platforms
4. Robust - Handle edge cases gracefully
5. Composable - Work with other verification types
Adding a New Verification Type
Template:


javascript
// services/verification-types/my-verification.js

/**
 * Verification Type: [NAME]
 * Purpose: [WHAT IT VERIFIES]
 * Use Cases: [AGENT SCENARIOS]
 */

class MyVerification {
  constructor(commitment, config) {
    this.commitment = commitment;
    this.config = config;
    this.results = [];
  }

  /**
   * Monitor execution
   * @returns {Promise<VerificationResult>}
   */
  async verify() {
    // 1. Gather data from platforms
    const data = await this.collectData();
    
    // 2. Apply verification logic
    const score = this.calculateScore(data);
    
    // 3. Generate attestation
    return {
      status: score >= this.config.threshold ? 'verified' : 'failed',
      score: score,
      evidence: data,
      timestamp: new Date().toISOString()
    };
  }

  async collectData() {
    // Platform-specific data collection
  }

  calculateScore(data) {
    // Deterministic scoring logic
    // Must be reproducible and auditable
  }

  // Helper methods...
}

module.exports = MyVerification;
Testing requirements:


javascript
// tests/verification-types/my-verification.test.js

describe('MyVerification', () => {
  it('should verify successful completion', async () => {
    // Test happy path
  });

  it('should detect failures accurately', async () => {
    // Test failure detection
  });

  it('should handle edge cases', async () => {
    // Test boundary conditions
  });

  it('should be deterministic', async () => {
    // Same input = same output
  });

  it('should handle platform errors gracefully', async () => {
    // Test error handling
  });
});
Dispute Resolution Considerations
When adding verification logic, ask:
1. Can agents reasonably comply with this?
2. Are failure modes clear and documentable?
3. How do we handle gray areas (partial completion)?
4. What evidence do we need to resolve disputes?
5. Can this be gamed? How do we prevent it?

Testing Requirements
Minimum Coverage
* Unit tests: 80% coverage
* Verification logic: 90% coverage
* Integration tests: Core workflows covered
* Edge cases: Document and test
Test Structure


javascript
// Good test structure
describe('Verification Service', () => {
  describe('consistency verification', () => {
    it('should verify daily posting commitment', async () => {
      // Arrange: Set up test data
      const commitment = {
        type: 'consistency',
        description: 'Post daily for 7 days',
        duration_days: 7
      };
      
      // Act: Run verification
      const result = await verifyConsistency(commitment);
      
      // Assert: Check results
      expect(result.status).toBe('verified');
      expect(result.completion_rate).toBe(100);
    });
  });
});
Running Tests


bash
# Run all tests
npm test

# Run specific test file
npm test -- verification-service.test.js

# Run with coverage
npm run test:coverage

# Watch mode (during development)
npm run test:watch

Documentation Standards
Code Comments


javascript
/**
 * Verify agent commitment across platforms
 * 
 * @param {Object} commitment - Commitment details
 * @param {string} commitment.type - Verification type (consistency|quality|time_bound)
 * @param {string} commitment.description - Human-readable commitment
 * @param {number} commitment.duration_days - Monitoring period
 * @param {Object} options - Additional options
 * @param {string} options.callback_url - Webhook for status updates
 * 
 * @returns {Promise<VerificationResult>} Attestation with signature
 * 
 * @example
 * const result = await verify({
 *   type: 'consistency',
 *   description: 'Post daily health tips',
 *   duration_days: 7
 * }, {
 *   callback_url: 'https://agent.com/webhook'
 * });
 */
async function verify(commitment, options = {}) {
  // Implementation
}
API Documentation
Every endpoint must have:
* Purpose and use case
* Request schema with examples
* Response schema with examples
* Error codes and meanings
* Rate limits and constraints
Example:


markdown
### POST /api/v1/verify

**Purpose:** Request verification of agent commitment

**Use case:** Agent wants proof of consistent action

**Request:**
```json
{
  "agent_id": "agent_pub_xyz",
  "commitment": {
    "type": "consistency",
    "description": "Post daily for 7 days",
    "duration_days": 7
  },
  "payment": {
    "method": "kinetix_token",
    "amount": "0.5_usdc_equivalent"
  }
}
```

**Response (200 OK):**
```json
{
  "verification_id": "ver_kx_1234",
  "status": "monitoring",
  "expected_completion": "2025-02-14T12:00:00Z"
}
```

**Errors:**
- `400` - Invalid commitment format
- `402` - Payment required
- `429` - Rate limit exceeded


---

## **Community & Communication**

### **Where to Ask Questions**

- **GitHub Discussions** - General questions, feature ideas
- **GitHub Issues** - Bug reports, specific problems
- **Moltbook** - Agent-to-agent discussions (@Kinetix)
- **Telegram** - Real-time developer chat (link in README)

### **Response Times**

- Bug reports: 1-2 business days
- Feature proposals: 3-5 business days
- PR reviews: Based on complexity (see PR Process above)

---

## **Recognition**

Contributors are recognized in:
- `CONTRIBUTORS.md` - All contributors listed
- Release notes - Significant contributions highlighted
- $KINETIX rewards - High-impact contributions may receive token rewards

---

## **Getting Help**

Stuck? Confused? Not sure where to start?

1. Check existing documentation (README, API.md)
2. Search GitHub Issues and Discussions
3. Ask in GitHub Discussions with "question" tag
4. Reach out on Telegram developer chat

**We're building this together. Your contributions matter.**

---

**Move with confidence. Build with Kinetix.**