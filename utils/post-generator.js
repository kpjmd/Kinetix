const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const BASE_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const APPROVAL_QUEUE_DIR = path.join(BASE_DATA_DIR, 'approval-queue');

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

  const queuePath = path.join(APPROVAL_QUEUE_DIR, `${postId}.json`);
  await fs.writeFile(queuePath, JSON.stringify(post, null, 2));

  return post;
}

module.exports = { createPostForApproval };
