#!/usr/bin/env node

/**
 * Start Kinetix x402 Verification Server
 *
 * Usage:
 *   node scripts/start-x402-server.js [--network base-sepolia|base-mainnet]
 */

require('dotenv').config();

// Parse network argument
const args = process.argv.slice(2);
const networkIndex = args.indexOf('--network');
const network = networkIndex >= 0 ? args[networkIndex + 1] : process.env.NETWORK_ID || 'base-sepolia';

// Normalize network format (accept both base-sepolia and base_sepolia)
const normalizedNetwork = network.replace('-', '_');

if (!['base_sepolia', 'base_mainnet'].includes(normalizedNetwork)) {
  console.error('\n❌ Invalid network. Use: base-sepolia or base-mainnet\n');
  process.exit(1);
}

// Set network ID in environment
process.env.NETWORK_ID = normalizedNetwork;

console.log(`\n🚀 Starting Kinetix x402 server on ${normalizedNetwork}...\n`);

// Start server. The module only self-starts when run directly (so tests can
// import the app without binding a port), so start it explicitly here.
const { start } = require('../api/x402/server');

start().catch(error => {
  console.error('Failed to initialize services:', error);
  process.exit(1);
});
