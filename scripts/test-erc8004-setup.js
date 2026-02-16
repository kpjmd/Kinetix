#!/usr/bin/env node

/**
 * Test ERC-8004 setup without making any blockchain transactions
 * Verifies all modules load correctly and configuration is valid
 */

require('dotenv').config();
const { ethers } = require('ethers');

console.log('\n=== ERC-8004 Setup Verification ===\n');

let errors = 0;
let warnings = 0;

// Test 1: Check KINETIX_SIGNING_KEY
console.log('1. Checking KINETIX_SIGNING_KEY...');
const signingKey = process.env.KINETIX_SIGNING_KEY;
if (!signingKey) {
  console.error('   ❌ KINETIX_SIGNING_KEY not found in .env');
  errors++;
} else {
  try {
    const wallet = new ethers.Wallet(signingKey);
    console.log(`   ✅ Valid signing key (address: ${wallet.address})`);
  } catch (error) {
    console.error('   ❌ Invalid signing key format');
    errors++;
  }
}

// Test 2: Check Pinata credentials
console.log('\n2. Checking Pinata IPFS credentials...');
const pinataApiKey = process.env.PINATA_API_KEY;
const pinataSecret = process.env.PINATA_SECRET_API_KEY;
if (!pinataApiKey || !pinataSecret) {
  console.error('   ❌ Pinata credentials missing');
  console.log('      Set PINATA_API_KEY and PINATA_SECRET_API_KEY in .env');
  errors++;
} else {
  console.log('   ✅ Pinata credentials found');
}

// Test 3: Check network configuration
console.log('\n3. Checking network configuration...');
const baseMainnetRpc = process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';
const baseSepoliaRpc = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const defaultNetwork = process.env.DEFAULT_NETWORK || 'base_sepolia';
console.log(`   ✅ Base Mainnet RPC: ${baseMainnetRpc}`);
console.log(`   ✅ Base Sepolia RPC: ${baseSepoliaRpc}`);
console.log(`   ✅ Default network: ${defaultNetwork}`);

// Test 4: Load modules
console.log('\n4. Loading ERC-8004 modules...');
try {
  const ipfsManager = require('../utils/ipfs-manager');
  console.log('   ✅ ipfs-manager.js loaded');
} catch (error) {
  console.error('   ❌ Failed to load ipfs-manager.js:', error.message);
  errors++;
}

try {
  const identityService = require('../utils/erc8004-identity');
  console.log('   ✅ erc8004-identity.js loaded');
} catch (error) {
  console.error('   ❌ Failed to load erc8004-identity.js:', error.message);
  errors++;
}

try {
  const dataStore = require('../services/data-store');
  console.log('   ✅ data-store.js loaded (with ERC-8004 functions)');
} catch (error) {
  console.error('   ❌ Failed to load data-store.js:', error.message);
  errors++;
}

// Test 5: Check metadata file
console.log('\n5. Checking metadata file...');
const fs = require('fs');
const path = require('path');
const metadataPath = path.join(__dirname, '../config/erc8004/kinetix_metadata.json');
try {
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
  console.log(`   ✅ Metadata file found and valid JSON`);
  console.log(`      Agent name: ${metadata.name || metadata.agent?.name}`);
  console.log(`      Version: ${metadata.version}`);
} catch (error) {
  console.error('   ❌ Failed to load metadata file:', error.message);
  errors++;
}

// Test 6: Check ABI file
console.log('\n6. Checking ABI file...');
const abiPath = path.join(__dirname, '../config/erc8004/erc8004-abis.json');
try {
  const abis = JSON.parse(fs.readFileSync(abiPath, 'utf-8'));
  console.log(`   ✅ ABI file found and valid JSON`);
  console.log(`      Identity Registry (Base Mainnet): ${abis.IdentityRegistry.address.base_mainnet}`);
  console.log(`      Identity Registry (Base Sepolia): ${abis.IdentityRegistry.address.base_sepolia}`);
  console.log(`      Reputation Registry (Base Mainnet): ${abis.ReputationRegistry.address.base_mainnet}`);
} catch (error) {
  console.error('   ❌ Failed to load ABI file:', error.message);
  errors++;
}

// Test 7: Check for existing registrations
console.log('\n7. Checking for existing registrations...');
const sepoliaPath = path.join(__dirname, '../data/erc8004/identity-base_sepolia.json');
const mainnetPath = path.join(__dirname, '../data/erc8004/identity-base_mainnet.json');

if (fs.existsSync(sepoliaPath)) {
  const sepoliaData = JSON.parse(fs.readFileSync(sepoliaPath, 'utf-8'));
  console.log(`   ⚠️  Sepolia registration found (Token ID: ${sepoliaData.tokenId})`);
  warnings++;
} else {
  console.log('   ✅ No Sepolia registration yet');
}

if (fs.existsSync(mainnetPath)) {
  const mainnetData = JSON.parse(fs.readFileSync(mainnetPath, 'utf-8'));
  console.log(`   ⚠️  Mainnet registration found (Token ID: ${mainnetData.tokenId})`);
  console.log('      You are already registered on mainnet!');
  warnings++;
} else {
  console.log('   ✅ No mainnet registration yet');
}

// Test 8: Validate metadata enhancements
console.log('\n8. Validating metadata enhancements...');
try {
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

  // Check services structure
  if (!metadata.services || metadata.services.length === 0) {
    console.error('   ❌ Missing services array');
    errors++;
  } else {
    const service = metadata.services[0];
    if (!service.name || !service.endpoint || !service.version) {
      console.error('   ❌ Services missing required fields (name, endpoint, version)');
      errors++;
    } else {
      console.log('   ✅ Services structure valid');
      console.log(`      Service: ${service.name} v${service.version}`);
      if (service.capabilities) {
        console.log(`      Capabilities: ${service.capabilities.join(', ')}`);
      }
    }
  }

  // Note: registrations will be added dynamically during upload
  console.log('   ℹ️  Registrations field will be injected during upload');

} catch (error) {
  console.error('   ❌ Metadata validation failed:', error.message);
  errors++;
}

// Summary
console.log('\n=== Summary ===\n');
if (errors === 0 && warnings === 0) {
  console.log('✅ All checks passed! You are ready to register.');
  console.log('\nNext steps:');
  console.log('  1. Check your wallet address: node scripts/check-erc8004-wallet.js');
  console.log('  2. Fund your wallet with Base ETH');
  console.log('  3. Test on Sepolia: npm run register:erc8004 -- --network base_sepolia');
  console.log('  4. Deploy to mainnet: npm run register:erc8004 -- --network base_mainnet');
} else if (errors === 0) {
  console.log(`✅ All required checks passed (${warnings} warning${warnings > 1 ? 's' : ''})`);
  console.log('\nYou can proceed with registration.');
} else {
  console.log(`❌ Found ${errors} error${errors > 1 ? 's' : ''} and ${warnings} warning${warnings > 1 ? 's' : ''}`);
  console.log('\nPlease fix the errors before proceeding.');
  process.exit(1);
}

console.log('\n');
