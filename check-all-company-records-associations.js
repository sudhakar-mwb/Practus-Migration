#!/usr/bin/env node

/**
 * For every Company already listed in destination_record_ids.json's
 * companies.mapping, checks its Contact/Company/Deal associations from the
 * source portal against what's already present in the destination portal.
 * Read-only - see check-associations-common.js for full details.
 *
 * USAGE:
 *   node --env-file=.env check-all-company-records-associations.js
 *
 * OUTPUT FILE: all_company_records_association_check.json
 */

'use strict';

const { runAssociationCheck } = require('./check-associations-common');

if (require.main === module) {
  runAssociationCheck('companies', 'all_company_records_association_check.json').catch((err) => {
    console.error('[fatal] Unexpected error:', err);
    process.exitCode = 1;
  });
}
