const moltbookApi = require('./moltbook-api');
const stateManager = require('./state-manager');

// Define tools for Claude function calling
const MOLTBOOK_TOOLS = [
  {
    name: 'moltbook_check_feed',
    description: 'Check the Moltbook feed for recent posts. Use this when the user asks to check feed, see what\'s happening, or browse Moltbook.',
    input_schema: {
      type: 'object',
      properties: {
        sort: {
          type: 'string',
          enum: ['hot', 'new', 'top'],
          description: 'Sort order for feed'
        },
        limit: {
          type: 'number',
          description: 'Number of posts to fetch',
          default: 5
        }
      }
    }
  },
  {
    name: 'moltbook_search',
    description: 'Search Moltbook for posts matching a query. Use this when the user asks to find, search, or look for posts about a topic.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'moltbook_upvote',
    description: 'Upvote a Moltbook post. Use this when the user asks to upvote, like, or support a post.',
    input_schema: {
      type: 'object',
      properties: {
        postId: {
          type: 'string',
          description: 'Post ID to upvote'
        }
      },
      required: ['postId']
    }
  },
  {
    name: 'moltbook_downvote',
    description: 'Downvote a Moltbook post. Use this when the user asks to downvote or dislike a post.',
    input_schema: {
      type: 'object',
      properties: {
        postId: {
          type: 'string',
          description: 'Post ID to downvote'
        }
      },
      required: ['postId']
    }
  },
  {
    name: 'moltbook_comment',
    description: 'Comment on a Moltbook post. Use this when the user asks to comment, reply, or respond to a post.',
    input_schema: {
      type: 'object',
      properties: {
        postId: {
          type: 'string',
          description: 'Post ID to comment on'
        },
        content: {
          type: 'string',
          description: 'Comment content'
        }
      },
      required: ['postId', 'content']
    }
  },
  {
    name: 'moltbook_post',
    description: 'Create a new Moltbook post. Use this when the user asks to post, share, or publish content.',
    input_schema: {
      type: 'object',
      properties: {
        submolt: {
          type: 'string',
          description: 'Submolt name (without m/ prefix)'
        },
        title: {
          type: 'string',
          description: 'Post title'
        },
        content: {
          type: 'string',
          description: 'Post content/body'
        }
      },
      required: ['submolt', 'title', 'content']
    }
  },
  {
    name: 'moltbook_follow',
    description: 'Follow an agent on Moltbook. Use this when the user asks to follow or connect with another agent.',
    input_schema: {
      type: 'object',
      properties: {
        agentName: {
          type: 'string',
          description: 'Agent name to follow'
        }
      },
      required: ['agentName']
    }
  },
  {
    name: 'moltbook_profile',
    description: 'Get Kinetix\'s Moltbook profile information. Use this when the user asks about profile stats, karma, or account info.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'moltbook_create_submolt',
    description: 'Propose creating a new submolt (community) on Moltbook. Use this when the user asks to create a new community, submolt, or topic area. Submolt creation requires approval before posting.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Submolt name/slug (lowercase, no spaces, e.g., "humanbiology")'
        },
        displayName: {
          type: 'string',
          description: 'Display name for the submolt (e.g., "Human Biology")'
        },
        description: {
          type: 'string',
          description: 'Brief description of the submolt purpose'
        },
        announcementContent: {
          type: 'string',
          description: 'Content for the announcement post (optional, will be generated if not provided)'
        }
      },
      required: ['name', 'displayName', 'description']
    }
  }
];

/**
 * Execute a Moltbook tool
 * @param {string} toolName - Tool name
 * @param {Object} input - Tool input parameters
 * @param {string} postingMode - Current posting mode ('approval' or 'autonomous')
 * @returns {Promise<Object>} Tool execution result
 */
async function executeTool(toolName, input, postingMode) {
  switch (toolName) {
    case 'moltbook_check_feed':
      const feed = await moltbookApi.getFeed(input.sort || 'hot', input.limit || 5);
      return {
        success: true,
        posts: feed.map(p => ({
          id: p.id,
          title: p.title,
          content: p.content?.slice(0, 200),
          author: p.author,
          submolt: p.submolt,
          upvotes: p.upvotes || p.score || 0
        }))
      };

    case 'moltbook_search':
      const results = await moltbookApi.search(input.query);
      const posts = results.posts || results.results || results || [];
      return {
        success: true,
        query: input.query,
        results: posts.slice(0, 5).map(p => ({
          id: p.id,
          title: p.title,
          content: p.content?.slice(0, 200),
          author: p.author,
          submolt: p.submolt
        }))
      };

    case 'moltbook_upvote':
      await moltbookApi.upvote(input.postId);
      await stateManager.recordEngagement('upvote', input.postId);
      return { success: true, postId: input.postId, action: 'upvoted' };

    case 'moltbook_downvote':
      await moltbookApi.downvote(input.postId);
      await stateManager.recordEngagement('downvote', input.postId);
      return { success: true, postId: input.postId, action: 'downvoted' };

    case 'moltbook_comment':
      if (postingMode === 'approval') {
        // Queue for approval
        const postGenerator = require('./post-generator');
        const queued = await postGenerator.createPostForApproval(
          input.content,
          null,
          'nlp_command',
          {
            type: 'comment',
            postId: input.postId
          }
        );
        return {
          success: true,
          queued: true,
          queueId: queued.id,
          message: 'Comment queued for approval. Use /approve to post it.'
        };
      }
      // Autonomous mode - post directly
      const comment = await moltbookApi.addComment(input.postId, input.content);
      await stateManager.recordEngagement('comment', input.postId);
      return {
        success: true,
        postId: input.postId,
        commentId: comment.id,
        message: 'Comment posted successfully'
      };

    case 'moltbook_post':
      if (postingMode === 'approval') {
        // Queue for approval
        const postGenerator = require('./post-generator');
        const queued = await postGenerator.createPostForApproval(
          input.content,
          input.submolt,
          'nlp_command',
          {
            type: 'post',
            title: input.title
          }
        );
        return {
          success: true,
          queued: true,
          queueId: queued.id,
          message: 'Post queued for approval. Use /approve to publish it.'
        };
      }
      // Autonomous mode - post directly
      const post = await moltbookApi.createPost(input.submolt, input.title, input.content);
      return {
        success: true,
        postId: post.id || post.post?.id,
        submolt: input.submolt,
        message: 'Post published successfully'
      };

    case 'moltbook_follow':
      await moltbookApi.followAgent(input.agentName);
      return {
        success: true,
        agentName: input.agentName,
        message: `Now following ${input.agentName}`
      };

    case 'moltbook_profile':
      const profile = await moltbookApi.getProfile();
      return {
        success: true,
        profile: {
          username: profile.username || profile.name,
          karma: profile.karma || profile.score || 0,
          posts: profile.post_count || profile.posts || 0,
          comments: profile.comment_count || profile.comments || 0,
          followers: profile.follower_count || profile.followers || 0,
          following: profile.following_count || profile.following || 0
        }
      };

    case 'moltbook_create_submolt':
      // Always queue for approval (submolt creation is sensitive)
      const postGenerator = require('./post-generator');

      // Generate announcement content if not provided
      const announcementContent = input.announcementContent ||
        `Starting m/${input.name} - ${input.description}\n\nJoin us to discuss and share about ${input.displayName.toLowerCase()}!`;

      const queued = await postGenerator.createPostForApproval(
        announcementContent,
        null, // No submolt yet (will be created)
        'nlp_command',
        {
          type: 'submolt_announcement',
          submolt_name: input.name,
          submolt_display_name: input.displayName,
          submolt_description: input.description,
          title: `Starting m/${input.name}`
        }
      );

      return {
        success: true,
        queued: true,
        queueId: queued.id,
        message: `Submolt creation queued for approval.\n\n` +
                 `Steps:\n` +
                 `1. /create_submolt ${queued.id} - Create m/${input.name}\n` +
                 `2. /approve ${queued.id} - Post announcement\n\n` +
                 `Name: ${input.name}\n` +
                 `Display: ${input.displayName}\n` +
                 `Description: ${input.description}`
      };

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

module.exports = {
  MOLTBOOK_TOOLS,
  executeTool
};
