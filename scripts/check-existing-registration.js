#!/usr/bin/env node

/**
 * Check if wallet is already registered on ERC-8004 Identity Registry
 */

require('dotenv').config();
const { ethers } = require('ethers');
const abiData = require('../config/erc8004/erc8004-abis.json');

async function checkRegistration(network) {
  console.log(`\n=== Checking ${network.toUpperCase()} ===`);

  const NETWORKS = {
    base_mainnet: {
      rpc: process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org',
      identityRegistry: abiData.IdentityRegistry.address.base_mainnet,
      explorer: 'https://basescan.org'
    },
    base_sepolia: {
      rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
      identityRegistry: abiData.IdentityRegistry.address.base_sepolia,
      explorer: 'https://sepolia.basescan.org'
    }
  };

  const config = NETWORKS[network];
  const provider = new ethers.JsonRpcProvider(config.rpc);
  const wallet = new ethers.Wallet(process.env.KINETIX_SIGNING_KEY);

  console.log(`Wallet address: ${wallet.address}`);
  console.log(`Registry contract: ${config.identityRegistry}`);

  // Create contract instance (read-only)
  const contract = new ethers.Contract(
    config.identityRegistry,
    abiData.IdentityRegistry.abi,
    provider
  );

  try {
    // Check total supply
    const totalSupply = await contract.totalSupply();
    console.log(`Total agents registered: ${totalSupply}`);

    // Try to find if this address owns any tokens
    // ERC-721 doesn't have a direct "getTokenByOwner" method
    // We'll need to check by querying events or trying token IDs

    // Check if address has balance (ERC-721 balanceOf)
    try {
      const balance = await contract.balanceOf(wallet.address);
      console.log(`\nTokens owned by this address: ${balance}`);

      if (balance > 0n) {
        console.log('⚠️  This wallet is ALREADY REGISTERED on this network!');

        // Try to find the token ID by checking recent token IDs
        console.log('\nAttempting to find your token ID...');
        for (let i = totalSupply - 1n; i >= 0n && i >= totalSupply - 100n; i--) {
          try {
            const owner = await contract.ownerOf(i);
            if (owner.toLowerCase() === wallet.address.toLowerCase()) {
              const tokenURI = await contract.tokenURI(i);
              console.log(`\n✓ Found your registration:`);
              console.log(`  Token ID: ${i}`);
              console.log(`  Metadata URI: ${tokenURI}`);
              console.log(`  View on explorer: ${config.explorer}/token/${config.identityRegistry}?a=${i}`);
              console.log(`  8004scan: https://8004scan.io/agent/${i}`);
              break;
            }
          } catch (e) {
            // Token doesn't exist or other error, continue
          }
        }
      } else {
        console.log('✓ This wallet is NOT registered on this network yet.');
        console.log('  You can proceed with registration.');
      }
    } catch (error) {
      console.log('Could not check balance:', error.message);
    }

  } catch (error) {
    console.error('Error checking registration:', error.message);
  }
}

async function main() {
  console.log('=== ERC-8004 Registration Checker ===');

  const signingKey = process.env.KINETIX_SIGNING_KEY;
  if (!signingKey) {
    console.error('\nERROR: KINETIX_SIGNING_KEY not found in .env');
    process.exit(1);
  }

  await checkRegistration('base_sepolia');
  await checkRegistration('base_mainnet');

  console.log('\n');
}

main().catch(console.error);
