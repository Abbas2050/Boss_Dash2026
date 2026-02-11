#!/usr/bin/env node

/**
 * Bulk Leverage Update Script
 * Update account leverage via command line
 *
 * Usage:
 *   node leverage_update.js <api_token> <accounts_file> <new_leverage>
 *   node leverage_update.js <api_token> "2 101610, 2 101611" <new_leverage>
 *
 * Example:
 *   node leverage_update.js "your-api-token" "accounts.txt" 100
 *   node leverage_update.js "your-api-token" "2 101610, 2 101611" 150
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('❌ Missing arguments');
  console.log('\nUsage:');
  console.log('  node leverage_update.js <api_token> <accounts_file_or_list> <new_leverage>');
  console.log('\nExamples:');
  console.log('  node leverage_update.js "your-token" "accounts.txt" 100');
  console.log('  node leverage_update.js "your-token" "2 101610, 2 101611" 150');
  process.exit(1);
}

const [apiToken, accountsInput, leverageStr] = args;
const leverage = parseInt(leverageStr);
const apiUrl = 'https://portal.skylinkscapital.com';

// Validate leverage
if (isNaN(leverage) || leverage < 1 || leverage > 500) {
  console.error('❌ Invalid leverage. Must be between 1 and 500');
  process.exit(1);
}

// Parse accounts from file or direct input
function parseAccounts(input) {
  let lines = [];

  // Check if input is a file path
  if (fs.existsSync(input)) {
    console.log(`📄 Reading accounts from: ${input}`);
    const content = fs.readFileSync(input, 'utf-8');
    lines = content.split('\n');
  } else {
    // Treat as direct account list
    lines = input.split(',');
  }

  const accounts = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Parse: "serverId login" or "serverId-login"
    const parts = trimmed.split(/[\s-]+/).filter(p => p.trim());

    if (parts.length >= 2) {
      const serverId = parseInt(parts[0]);
      const login = parts[1];

      if (!isNaN(serverId) && login) {
        accounts.push({ serverId, login });
      }
    }
  }

  return accounts;
}

// Update single account leverage
async function updateLeverage(serverId, login, newLeverage) {
  const url = `${apiUrl}/rest/accounts/${serverId}-${login}?version=1.0.0`;

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
      },
      body: JSON.stringify({ leverage: newLeverage }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Batch update with progress tracking
async function batchUpdate(accounts, newLeverage) {
  console.log(`\n📋 Processing ${accounts.length} account(s)...`);
  console.log(`🎯 New leverage: 1:${newLeverage}\n`);

  const results = {
    successful: [],
    failed: [],
  };

  for (let i = 0; i < accounts.length; i++) {
    const { serverId, login } = accounts[i];
    const progress = `[${i + 1}/${accounts.length}]`;

    process.stdout.write(`${progress} Updating ${serverId}-${login}... `);

    const result = await updateLeverage(serverId, login, newLeverage);

    if (result.success) {
      console.log(`✅ OK (new leverage: 1:${result.data.leverage})`);
      results.successful.push({
        serverId,
        login,
        leverage: result.data.leverage,
      });
    } else {
      console.log(`❌ FAILED`);
      results.failed.push({
        serverId,
        login,
        error: result.error,
      });
    }

    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return results;
}

// Main execution
(async () => {
  try {
    const accounts = parseAccounts(accountsInput);

    if (accounts.length === 0) {
      console.error('❌ No valid accounts found in input');
      process.exit(1);
    }

    console.log('🚀 Bulk Leverage Update Tool');
    console.log(`📌 API URL: ${apiUrl}`);
    console.log(`🔐 Token: ${apiToken.substring(0, 10)}...`);
    console.log(`📊 Accounts to update: ${accounts.length}`);

    const results = await batchUpdate(accounts, leverage);

    // Print summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 SUMMARY');
    console.log('='.repeat(50));
    console.log(`✅ Successful: ${results.successful.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);
    console.log(`📈 Success Rate: ${((results.successful.length / accounts.length) * 100).toFixed(1)}%`);

    if (results.failed.length > 0) {
      console.log('\n❌ Failed Accounts:');
      results.failed.forEach(({ serverId, login, error }) => {
        console.log(`   ${serverId}-${login}: ${error}`);
      });
    }

    console.log('\n✨ Update complete!');

    // Save results to file
    const resultsFile = `leverage_update_results_${Date.now()}.json`;
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    console.log(`💾 Results saved to: ${resultsFile}`);

    // Exit with appropriate code
    process.exit(results.failed.length > 0 ? 1 : 0);
  } catch (error) {
    console.error('🚨 Fatal error:', error.message);
    process.exit(1);
  }
})();
