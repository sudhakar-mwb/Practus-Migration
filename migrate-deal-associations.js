#!/usr/bin/env node

/**
 * Migrates Deal associations (Deal<->Contact, Deal<->Company, Deal<->Deal)
 * from the source HubSpot portal to the destination portal, using each
 * record's tm_contact_record_id / tm_company_record_id / tm_deal_record_id
 * property to map source records to their already-migrated destination
 * counterparts.
 *
 * All the actual logic lives in ./hubspot-associations-common.js (shared by
 * this file and migrate-contact-associations.js / migrate-company-associations.js)
 * so the three scripts stay in sync instead of drifting apart as separate
 * copies of the same ~700 lines.
 *
 * REQUIRED ENV VARS: SOURCE_HUBSPOT_TOKEN, DESTINATION_HUBSPOT_TOKEN
 * OPTIONAL ENV VARS: DRY_RUN, OUTPUT_DIR, REQUEST_DELAY_MS, MAX_RETRIES,
 *                    HUBSPOT_API_BASE (for testing against a mock server)
 *
 * USAGE:
 *   node --env-file=.env migrate-deal-associations.js
 *
 * Log files (shared with the other two scripts - see hubspot-associations-common.js):
 *   association_migration_success.json
 *   association_migration_errors.json
 *   association_migration_mapping.json
 */

'use strict';

const { migratePrimaryObjectAssociations } = require('./hubspot-associations-common');

if (require.main === module) {
  migratePrimaryObjectAssociations('deals').catch((err) => {
    console.error('[fatal] Unexpected error:', err);
    process.exitCode = 1;
  });
}
