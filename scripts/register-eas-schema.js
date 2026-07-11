#!/usr/bin/env node

/**
 * EAS Schema Registration Script for Kinetix
 *
 * One-time, per-network, IRREVERSIBLE: registers Kinetix's attestation schema
 * on the EAS SchemaRegistry and writes the resulting schemaUID into
 * config/eas/eas-config.json. Run on base_sepolia first and validate before
 * ever running against base_mainnet.
 *
 * Usage:
 *   node scripts/register-eas-schema.js --network base_sepolia
 *   node scripts/register-eas-schema.js --network base_mainnet
 *
 * Prerequisites:
 *   - KINETIX_SIGNING_KEY set in .env
 *   - ETH balance in wallet for gas
 */

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const { ethers } = require('ethers');
const { SchemaRegistry } = require('@ethereum-attestation-service/eas-sdk');

const { SCHEMA_STRING } = require('../utils/eas-attestation');
const { createSigner } = require('../utils/signing-key');

/**
 * Prompt on stdin for a typed confirmation. Returns the trimmed line.
 */
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const CONFIG_PATH = path.join(__dirname, '../config/eas/eas-config.json');

function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function main() {
  const network = process.argv.includes('--network')
    ? process.argv[process.argv.indexOf('--network') + 1]
    : process.env.DEFAULT_NETWORK || 'base_sepolia';

  log(`=== Kinetix EAS Schema Registration ===`);
  log(`Network: ${network}`);
  log(`Schema: ${SCHEMA_STRING}`);

  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
  const networkConfig = config[network];
  if (!networkConfig) {
    throw new Error(`Unknown network: ${network}. Use base_mainnet or base_sepolia`);
  }
  if (networkConfig.schemaUID) {
    throw new Error(
      `Schema already registered for ${network}: ${networkConfig.schemaUID}. ` +
      `Schema registration is irreversible — remove it from config manually if you really intend to register a new one.`
    );
  }

  const rpcUrl = network === 'base_mainnet'
    ? (process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org')
    : (process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = createSigner(provider);
  log(`Signing wallet: ${signer.address}`);

  const balance = await provider.getBalance(signer.address);
  log(`Wallet balance: ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    throw new Error('Wallet has zero balance — fund it with ETH for gas before registering.');
  }

  // Mainnet registration is one-time and IRREVERSIBLE. Confirm by default;
  // only an explicit --yes flag skips the interactive gate (e.g. CI).
  if (network === 'base_mainnet') {
    const skip = process.argv.includes('--yes');
    if (skip) {
      log('\nMAINNET DEPLOYMENT (irreversible) — proceeding via --yes flag.');
    } else {
      log('\n⚠️  MAINNET DEPLOYMENT — this registers the EAS schema on Base mainnet.');
      log('   This is ONE-TIME and IRREVERSIBLE for this network.');
      const answer = await prompt(`   Type "${network}" to confirm, anything else to abort: `);
      if (answer !== network) {
        log('Aborted — confirmation did not match. No transaction sent.');
        process.exit(1);
      }
    }
  }

  const schemaRegistry = new SchemaRegistry(networkConfig.schemaRegistryAddress);
  schemaRegistry.connect(signer);

  log('\n--- Registering schema ---');
  const tx = await schemaRegistry.register({
    schema: SCHEMA_STRING,
    resolverAddress: ethers.ZeroAddress,
    revocable: true
  });

  const schemaUID = await tx.wait();
  log(`Schema UID: ${schemaUID}`);

  networkConfig.schemaUID = schemaUID;
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  log(`Saved schemaUID to ${CONFIG_PATH}`);

  log('\n=== REGISTRATION COMPLETE ===');
  log(`Network: ${network}`);
  log(`Schema UID: ${schemaUID}`);
  log(`Explorer: ${networkConfig.explorer}/schema/view/${schemaUID}`);

  return { network, schemaUID };
}

main()
  .then(() => {
    log('\nScript completed successfully.');
    process.exit(0);
  })
  .catch((error) => {
    // Only the message — never dump the full error object, which for a
    // signer-construction failure can contain raw key material.
    log('Schema registration failed: ' + error.message);
    process.exit(1);
  });
