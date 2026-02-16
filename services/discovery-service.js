// /services/discovery-service.js
// Manages verification suggestion queue from heartbeat discoveries

const fs = require('fs').promises;
const path = require('path');
const dataStore = require('./data-store');

const DISCOVERY_DIR = path.join(__dirname, '../data/discovery-queue');

class DiscoveryService {
  constructor() {
    this.verificationService = null;
    this.bot = null;
    this.adminId = process.env.TELEGRAM_ADMIN_ID;
  }

  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [DiscoveryService] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  /**
   * Initialize with dependencies
   */
  initialize(verificationService, bot) {
    this.verificationService = verificationService;
    this.bot = bot;
    this._log('Initialized');
  }

  /**
   * Ensure discovery-queue directory exists
   */
  async ensureDirectory() {
    await fs.mkdir(DISCOVERY_DIR, { recursive: true });
  }

  /**
   * Add a verification request (explicit agent request)
   * Creates a suggestion with source_type: 'explicit_request'
   */
  async addVerificationRequest(request) {
    // Build dedup key
    const agentId = (request.agent_id || '').toLowerCase().trim();
    const normalizedClaim = (request.normalized_claim || request.claim_text || '').toLowerCase().trim();
    const dedupKey = `${agentId}::${normalizedClaim}`;

    // Check for duplicates
    if (await this._isDuplicate(dedupKey)) {
      this._log(`Duplicate verification request skipped: ${dedupKey}`);
      return null;
    }

    const id = dataStore.generateId('vreq_');
    const suggestion = {
      id,
      status: 'pending',
      source_type: 'explicit_request',
      source_platform: request.source_platform,
      source_post_id: request.source_post_id || null,
      source_post_url: request.source_platform === 'moltbook' && request.source_post_id
        ? `https://www.moltbook.com/posts/${request.source_post_id}`
        : null,
      source_event_id: request.source_event_id || null,
      agent_id: request.agent_id,
      agent_pubkey: request.agent_pubkey || null,
      claim_text: request.claim_text,
      original_content_snippet: request.original_content_snippet || '',
      suggested_verification: request.suggested_verification,
      confidence: 'high',
      discovered_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
      verification_id: null,
      dedup_key: dedupKey
    };

    const filePath = path.join(DISCOVERY_DIR, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(suggestion, null, 2), 'utf-8');

    this._log(`New verification request: ${id} (${dedupKey})`);

    // Notify admin with different messaging
    await this._notifyAdminRequest(suggestion);

    return suggestion;
  }

  /**
   * Add a suggestion from heartbeat discoveries
   * Deduplicates by agent_id + normalized_claim
   */
  async addSuggestion(discovery) {
    // Build dedup key
    const agentId = (discovery.agent_id || '').toLowerCase().trim();
    const normalizedClaim = (discovery.normalized_claim || discovery.claim_text || '').toLowerCase().trim();
    const dedupKey = `${agentId}::${normalizedClaim}`;

    // Check for duplicates
    if (await this._isDuplicate(dedupKey)) {
      this._log(`Duplicate skipped: ${dedupKey}`);
      return null;
    }

    const id = dataStore.generateId('disc_');
    const suggestion = {
      id,
      status: 'pending',
      source_type: discovery.source_type || 'passive_discovery',
      source_platform: discovery.source_platform,
      source_post_id: discovery.source_post_id || null,
      source_post_url: discovery.source_platform === 'moltbook' && discovery.source_post_id
        ? `https://www.moltbook.com/posts/${discovery.source_post_id}`
        : null,
      source_event_id: discovery.source_event_id || null,
      agent_id: discovery.agent_id,
      agent_pubkey: discovery.agent_pubkey || null,
      claim_text: discovery.claim_text,
      original_content_snippet: discovery.original_content_snippet || '',
      suggested_verification: discovery.suggested_verification,
      confidence: discovery.confidence || 'medium',
      discovered_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
      verification_id: null,
      dedup_key: dedupKey
    };

    const filePath = path.join(DISCOVERY_DIR, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(suggestion, null, 2), 'utf-8');

    this._log(`New suggestion: ${id} (${dedupKey})`);

    // Notify admin
    await this._notifyAdmin(suggestion);

    return suggestion;
  }

  /**
   * Check if a discovery is a duplicate
   */
  async _isDuplicate(dedupKey) {
    try {
      const files = await fs.readdir(DISCOVERY_DIR);
      for (const f of files.filter(f => f.endsWith('.json'))) {
        const content = await fs.readFile(path.join(DISCOVERY_DIR, f), 'utf-8');
        const suggestion = JSON.parse(content);
        if (suggestion.dedup_key === dedupKey) {
          return true;
        }
      }
      return false;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * List all pending suggestions
   */
  async listPending() {
    try {
      const files = await fs.readdir(DISCOVERY_DIR);
      const suggestions = await Promise.all(
        files
          .filter(f => f.endsWith('.json'))
          .map(async f => {
            const content = await fs.readFile(path.join(DISCOVERY_DIR, f), 'utf-8');
            return JSON.parse(content);
          })
      );
      return suggestions
        .filter(s => s.status === 'pending')
        .sort((a, b) => new Date(b.discovered_at) - new Date(a.discovered_at));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /**
   * Get a single suggestion by ID
   */
  async getSuggestion(id) {
    const filePath = path.join(DISCOVERY_DIR, `${id}.json`);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Approve a suggestion -> creates a real verification
   */
  async approveSuggestion(id, approver = 'admin') {
    const suggestion = await this.getSuggestion(id);
    if (!suggestion) throw new Error(`Suggestion not found: ${id}`);
    if (suggestion.status !== 'pending') throw new Error(`Suggestion ${id} already ${suggestion.status}`);

    // Build commitment from the suggested verification
    const sv = suggestion.suggested_verification;
    const commitment = {
      agent_id: suggestion.agent_id,
      pubkey: suggestion.agent_pubkey || '',
      platform_profiles: {},
      description: sv.description,
      verification_type: sv.verification_type,
      criteria: sv.criteria
    };

    // Set platform profile based on source
    if (suggestion.source_platform === 'moltbook') {
      commitment.platform_profiles.moltbook = suggestion.agent_id;
    } else if (suggestion.source_platform === 'clawstr') {
      commitment.platform_profiles.clawstr = suggestion.agent_pubkey || suggestion.agent_id;
    }

    // Create the real verification
    const result = await this.verificationService.createVerification(commitment);

    // Update suggestion
    suggestion.status = 'approved';
    suggestion.decided_at = new Date().toISOString();
    suggestion.decided_by = approver;
    suggestion.verification_id = result.verification_id;

    const filePath = path.join(DISCOVERY_DIR, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(suggestion, null, 2), 'utf-8');

    this._log(`Approved ${id} -> verification ${result.verification_id}`);
    return result;
  }

  /**
   * Reject a suggestion
   */
  async rejectSuggestion(id, rejector = 'admin') {
    const suggestion = await this.getSuggestion(id);
    if (!suggestion) throw new Error(`Suggestion not found: ${id}`);
    if (suggestion.status !== 'pending') throw new Error(`Suggestion ${id} already ${suggestion.status}`);

    suggestion.status = 'rejected';
    suggestion.decided_at = new Date().toISOString();
    suggestion.decided_by = rejector;

    const filePath = path.join(DISCOVERY_DIR, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(suggestion, null, 2), 'utf-8');

    this._log(`Rejected ${id}`);
    return suggestion;
  }

  /**
   * Notify admin about an explicit verification request via Telegram
   */
  async _notifyAdminRequest(suggestion) {
    if (!this.bot || !this.adminId) return;

    try {
      const platformEmoji = suggestion.source_platform === 'moltbook' ? '📰' : '🌐';

      const text =
        `🙋 *Agent Requesting Verification*\n\n` +
        `${platformEmoji} Platform: ${suggestion.source_platform}\n` +
        `👤 Agent: ${suggestion.agent_id}\n` +
        `🟢 Confidence: high (explicit request)\n\n` +
        `📝 Commitment: "${suggestion.claim_text}"\n\n` +
        `📋 Suggested: ${suggestion.suggested_verification.verification_type} verification\n` +
        `   ${suggestion.suggested_verification.description}\n\n` +
        `This agent EXPLICITLY asked for verification.\n\n` +
        `✅ /approve_verify ${suggestion.id}\n` +
        `❌ /reject_verify ${suggestion.id}\n` +
        `📄 /discoveries - View all pending`;

      await this.bot.telegram.sendMessage(this.adminId, text, { parse_mode: 'Markdown' });
    } catch (error) {
      this._log(`Failed to notify admin: ${error.message}`);
    }
  }

  /**
   * Notify admin about a new discovery via Telegram
   */
  async _notifyAdmin(suggestion) {
    if (!this.bot || !this.adminId) return;

    try {
      const platformEmoji = suggestion.source_platform === 'moltbook' ? '📰' : '🌐';
      const confidenceEmoji = {
        high: '🟢',
        medium: '🟡',
        low: '🔴'
      }[suggestion.confidence] || '🟡';

      const text =
        `🔍 *New Verification Discovery*\n\n` +
        `${platformEmoji} Platform: ${suggestion.source_platform}\n` +
        `👤 Agent: ${suggestion.agent_id}\n` +
        `${confidenceEmoji} Confidence: ${suggestion.confidence}\n\n` +
        `📝 Claim: "${suggestion.claim_text}"\n\n` +
        `📋 Suggested: ${suggestion.suggested_verification.verification_type} verification\n` +
        `   ${suggestion.suggested_verification.description}\n\n` +
        `✅ /approve_verify ${suggestion.id}\n` +
        `❌ /reject_verify ${suggestion.id}\n` +
        `📄 /discoveries - View all pending`;

      await this.bot.telegram.sendMessage(this.adminId, text, { parse_mode: 'Markdown' });
    } catch (error) {
      this._log(`Failed to notify admin: ${error.message}`);
    }
  }
}

module.exports = new DiscoveryService();
module.exports.DiscoveryService = DiscoveryService;
