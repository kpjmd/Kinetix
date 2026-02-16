/**
 * Clawstr NLP Tools - Claude function calling definitions for Clawstr interactions
 *
 * This module provides NLP tools for Claude to interact with Clawstr (Nostr-based AI agent social network)
 * Mirrors the Moltbook pattern for consistency.
 */

const clawstrApi = require('./clawstr-api');
const stateManager = require('./state-manager');

// Define tools for Claude function calling
const CLAWSTR_TOOLS = [
  {
    name: 'clawstr_check_feed',
    description: 'Check a Clawstr subclaw feed for recent posts. Use this when the user asks to check Clawstr, browse a subclaw, or see what\'s happening on Nostr.',
    input_schema: {
      type: 'object',
      properties: {
        subclaw: {
          type: 'string',
          description: 'Subclaw identifier (e.g., "/c/ai-freedom", "/c/agent-economy")',
          default: '/c/ai-freedom'
        },
        limit: {
          type: 'number',
          description: 'Number of posts to fetch',
          default: 10
        }
      }
    }
  },
  {
    name: 'clawstr_post',
    description: 'Create a new post in a Clawstr subclaw. Use this when the user asks to post to Clawstr, share content on Nostr, or publish to a subclaw. Respects posting_mode setting.',
    input_schema: {
      type: 'object',
      properties: {
        subclaw: {
          type: 'string',
          description: 'Subclaw identifier (e.g., "/c/ai-freedom", "/c/agent-economy")'
        },
        content: {
          type: 'string',
          description: 'Post content'
        }
      },
      required: ['subclaw', 'content']
    }
  },
  {
    name: 'clawstr_reply',
    description: 'Reply to a Clawstr event. Use this when the user asks to reply, respond, or comment on a Clawstr post. Respects posting_mode setting.',
    input_schema: {
      type: 'object',
      properties: {
        eventId: {
          type: 'string',
          description: 'Event ID to reply to (hex format)'
        },
        content: {
          type: 'string',
          description: 'Reply content'
        },
        subclaw: {
          type: 'string',
          description: 'Subclaw where original event was posted'
        },
        parentPubkey: {
          type: 'string',
          description: 'Public key of parent event author (hex format)'
        }
      },
      required: ['eventId', 'content', 'subclaw', 'parentPubkey']
    }
  },
  {
    name: 'clawstr_react',
    description: 'React to a Clawstr event (upvote or downvote). Use this when the user asks to upvote, like, or react to a post. Reactions are always executed immediately (not queued).',
    input_schema: {
      type: 'object',
      properties: {
        eventId: {
          type: 'string',
          description: 'Event ID to react to (hex format)'
        },
        reaction: {
          type: 'string',
          enum: ['+', '-', 'upvote', 'downvote'],
          description: 'Reaction type: "+" or "upvote" for upvote, "-" or "downvote" for downvote',
          default: '+'
        }
      },
      required: ['eventId']
    }
  },
  {
    name: 'clawstr_notifications',
    description: 'Check Clawstr notifications (mentions and replies). Use this when the user asks to check notifications, see mentions, or check replies on Clawstr.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of notifications to fetch',
          default: 10
        }
      }
    }
  },
  {
    name: 'clawstr_profile',
    description: 'Get Kinetix\'s Clawstr/Nostr profile information. Use this when the user asks about Clawstr profile, Nostr identity, or public key.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  }
];

/**
 * Execute a Clawstr tool
 * @param {string} toolName - Tool name
 * @param {Object} input - Tool input parameters
 * @param {string} postingMode - Current posting mode ('approval' or 'autonomous')
 * @returns {Promise<Object>} Tool execution result
 */
async function executeTool(toolName, input, postingMode) {
  switch (toolName) {
    case 'clawstr_check_feed':
      const subclaw = input.subclaw || '/c/ai-freedom';
      const feed = await clawstrApi.getFeed(subclaw, input.limit || 10);

      return {
        success: true,
        subclaw,
        count: feed.length,
        posts: feed.map(event => ({
          id: event.id,
          content: event.content?.slice(0, 300),
          author: event.pubkey?.slice(0, 16) + '...',
          created_at: event.created_at ? new Date(event.created_at * 1000).toISOString() : null,
          tags: event.tags?.filter(t => t[0] === 'I' || t[0] === 'p').slice(0, 3)
        }))
      };

    case 'clawstr_post':
      if (postingMode === 'approval') {
        // Queue for approval
        const postGenerator = require('./post-generator');
        const queued = await postGenerator.createPostForApproval(
          input.content,
          null, // No submolt for Clawstr
          'nlp_command',
          {
            platform: 'clawstr',
            type: 'post',
            subclaw: input.subclaw
          }
        );
        return {
          success: true,
          queued: true,
          queueId: queued.id,
          message: `Clawstr post queued for approval.\nSubclaw: ${input.subclaw}\nUse /approve ${queued.id} to publish.`
        };
      }

      // Autonomous mode - post directly
      const postResult = await clawstrApi.createPost(input.subclaw, input.content);
      await stateManager.recordEngagement('clawstr_post', postResult.eventId, {
        subclaw: input.subclaw,
        eventId: postResult.eventId
      });

      return {
        success: true,
        eventId: postResult.eventId,
        subclaw: input.subclaw,
        message: 'Post published to Clawstr successfully'
      };

    case 'clawstr_reply':
      if (postingMode === 'approval') {
        // Queue for approval
        const postGenerator = require('./post-generator');
        const queued = await postGenerator.createPostForApproval(
          input.content,
          null,
          'nlp_command',
          {
            platform: 'clawstr',
            type: 'reply',
            parentEventId: input.eventId,
            subclaw: input.subclaw,
            parentPubkey: input.parentPubkey
          }
        );
        return {
          success: true,
          queued: true,
          queueId: queued.id,
          message: `Clawstr reply queued for approval.\nReplying to: ${input.eventId.slice(0, 16)}...\nUse /approve ${queued.id} to publish.`
        };
      }

      // Autonomous mode - post directly
      const replyResult = await clawstrApi.createReply(
        input.eventId,
        input.content,
        input.subclaw,
        input.parentPubkey
      );
      await stateManager.recordEngagement('clawstr_reply', replyResult.eventId, {
        parentEventId: input.eventId,
        subclaw: input.subclaw,
        eventId: replyResult.eventId
      });

      return {
        success: true,
        eventId: replyResult.eventId,
        parentEventId: input.eventId,
        message: 'Reply posted to Clawstr successfully'
      };

    case 'clawstr_react':
      // Reactions are always immediate (not queued)
      const reactionResult = await clawstrApi.react(input.eventId, input.reaction || '+');
      await stateManager.recordEngagement('clawstr_react', input.eventId);

      return {
        success: true,
        eventId: reactionResult.eventId,
        targetEventId: input.eventId,
        reaction: reactionResult.reaction,
        message: `Reacted with ${reactionResult.reaction} to event`
      };

    case 'clawstr_notifications':
      const notifications = await clawstrApi.getNotifications(input.limit || 10);

      return {
        success: true,
        count: notifications.length,
        notifications: notifications.map(event => ({
          id: event.id,
          kind: event.kind,
          content: event.content?.slice(0, 200),
          author: event.pubkey?.slice(0, 16) + '...',
          created_at: event.created_at ? new Date(event.created_at * 1000).toISOString() : null,
          type: event.kind === 1111 ? 'mention/reply' : event.kind === 7 ? 'reaction' : 'other'
        }))
      };

    case 'clawstr_profile':
      const profile = await clawstrApi.getProfile();
      const npub = await clawstrApi.getPublicKey();
      const hexPubkey = await clawstrApi.getHexPublicKey();

      // Get social state for additional info
      const socialState = await stateManager.loadState('social');

      return {
        success: true,
        profile: {
          name: profile?.name || 'Kinetix',
          about: profile?.about || 'AI agent on Nostr',
          npub: npub,
          hex_pubkey: hexPubkey.slice(0, 16) + '...',
          subclaws: socialState.clawstr_subclaws || [],
          profile_updated: socialState.clawstr_profile_updated
        }
      };

    default:
      throw new Error(`Unknown Clawstr tool: ${toolName}`);
  }
}

module.exports = {
  CLAWSTR_TOOLS,
  executeTool
};
