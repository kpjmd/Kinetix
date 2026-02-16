const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

async function createPostForApproval(content, submolt = 'general', trigger = 'manual', metadata = {}) {
  const postId = crypto.randomBytes(4).toString('hex');
  const timestamp = new Date().toISOString();

  const post = {
    id: postId,
    content,
    submolt,
    trigger,
    timestamp,
    status: 'pending',
    metadata
  };

  const queuePath = path.join(__dirname, '../data/approval-queue', `${postId}.json`);
  await fs.writeFile(queuePath, JSON.stringify(post, null, 2));

  return post;
}

module.exports = { createPostForApproval };
