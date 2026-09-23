#!/usr/bin/env node

/**
 * For every Contact already listed in destination_record_ids.json's
 * contacts.mapping, checks its Contact/Company/Deal associations from the
 * source portal against what's already present in the destination portal.
 * Read-only - see check-associations-common.js for full details.
 *
 * USAGE:
 *   node --env-file=.env check-all-contact-records-associations.js
 *
 * OUTPUT FILE: all_contact_records_association_check.json
 */

'use strict';

const { runAssociationCheck } = require('./check-associations-common');

if (require.main === module) {
  runAssociationCheck('contacts', 'all_contact_records_association_check.json').catch((err) => {
    console.error('[fatal] Unexpected error:', err);
    process.exitCode = 1;
  });
}
