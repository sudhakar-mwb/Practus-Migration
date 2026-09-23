#!/usr/bin/env node

/**
 * Reads all_contact_records_association_check.json (produced by
 * check-all-contact-records-associations.js) and live-verifies each of its
 * associations against the DESTINATION portal. Read-only - see
 * verify-associations-in-destination-common.js for full details.
 *
 * USAGE:
 *   node --env-file=.env verify-contact-associations-in-destination.js
 *
 * OUTPUT FILE: contact_association_destination_verification.json
 */

'use strict';

const { runVerification } = require('./verify-associations-in-destination-common');

if (require.main === module) {
  runVerification('contacts', 'all_contact_records_association_check.json', 'contact_association_destination_verification.json').catch((err) => {
    console.error('[fatal] Unexpected error:', err);
    process.exitCode = 1;
  });
}
