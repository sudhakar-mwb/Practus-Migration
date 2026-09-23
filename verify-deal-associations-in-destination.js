#!/usr/bin/env node

/**
 * Reads all_deal_records_association_check.json (produced by
 * check-all-deal-records-associations.js) and live-verifies each of its
 * associations against the DESTINATION portal. Read-only - see
 * verify-associations-in-destination-common.js for full details.
 *
 * USAGE:
 *   node --env-file=.env verify-deal-associations-in-destination.js
 *
 * OUTPUT FILE: deal_association_destination_verification.json
 */

'use strict';

const { runVerification } = require('./verify-associations-in-destination-common');

if (require.main === module) {
  runVerification('deals', 'all_deal_records_association_check.json', 'deal_association_destination_verification.json').catch((err) => {
    console.error('[fatal] Unexpected error:', err);
    process.exitCode = 1;
  });
}
