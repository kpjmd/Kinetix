#!/usr/bin/env node

/**
 * One-time, non-blocking backfill: adds the `eas` block and
 * `recipient.erc8004_token_id` field to historical attestation receipts
 * that predate them, so downstream code doesn't need indefinite
 * optional-chaining for these fields.
 *
 * Safe to re-run — skips files that already have both fields.
 *
 * Usage:
 *   node scripts/backfill-eas-block.js
 */

require('dotenv').config();
const dataStore = require('../services/data-store');

function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function main() {
  const receipts = await dataStore.listAttestations();
  log(`Found ${receipts.length} attestation(s)`);

  let updated = 0;
  let skipped = 0;

  for (const receipt of receipts) {
    let changed = false;

    if (!receipt.eas) {
      receipt.eas = {
        schema_uid: null,
        attestation_uid: null,
        tx_hash: null,
        network: null,
        explorer_url: null,
        submitted_at: null,
        status: 'pending'
      };
      changed = true;
    }

    if (receipt.recipient && receipt.recipient.erc8004_token_id === undefined) {
      receipt.recipient.erc8004_token_id = null;
      changed = true;
    }

    if (receipt.metadata && receipt.metadata.onchain_retry_count === undefined) {
      receipt.metadata.onchain_retry_count = 0;
      changed = true;
    }

    if (changed) {
      await dataStore.saveAttestation(receipt);
      updated++;
      log(`Backfilled ${receipt.receipt_id}`);
    } else {
      skipped++;
    }
  }

  log('=== BACKFILL COMPLETE ===');
  log(`Updated: ${updated} | Already current: ${skipped}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log('Backfill failed: ' + error.message);
    console.error(error);
    process.exit(1);
  });
