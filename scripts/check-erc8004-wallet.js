#!/usr/bin/env node

/**
 * Quick script to check the wallet address that will be used for ERC-8004 registration
 */

require('dotenv').config();
const { ethers } = require('ethers');

console.log('\n=== ERC-8004 Wallet Check ===\n');

const signingKey = process.env.KINETIX_SIGNING_KEY;

if (!signingKey) {
  console.error('ERROR: KINETIX_SIGNING_KEY not found in .env');
  console.error('This is required for ERC-8004 registration.');
  process.exit(1);
}

try {
  const wallet = new ethers.Wallet(signingKey);
  console.log('Wallet Address:', wallet.address);
  console.log('\nThis is the address that will:');
  console.log('  - Own the ERC-8004 Identity NFT');
  console.log('  - Sign attestations');
  console.log('  - Be listed as the controller in metadata');
  console.log('\nMake sure this wallet is funded with Base ETH!');
  console.log('\nTo check balance on Base mainnet:');
  console.log(`  https://basescan.org/address/${wallet.address}`);
  console.log('\nTo check balance on Base Sepolia:');
  console.log(`  https://sepolia.basescan.org/address/${wallet.address}`);
  console.log('\n');
} catch (error) {
  console.error('ERROR: Invalid KINETIX_SIGNING_KEY format');
  console.error(error.message);
  process.exit(1);
}
