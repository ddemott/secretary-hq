/**
 * Give a business its own copy of the template business for its type.
 *
 * The template ("Auto Shop Template", "Salon Template" …) lives as ordinary,
 * read-only rows; copy_business_template_to_tenant() duplicates its services
 * (no prices), bays/chairs, skills, placeholder staff, who-does-what links and
 * knowledge starters into this business's own rows. The owner then fills out
 * that copy in the setup wizard. See
 * supabase/migrations/20260925000000_business_template_tenants.sql.
 *
 * Best-effort, inside the caller's transaction: a savepoint keeps a failed
 * copy from aborting the transaction that creates or re-types the business —
 * the business is still valid, it just starts empty (today's behaviour). A
 * failure is counted and logged, never silent.
 */
import type { PoolClient } from 'pg';
import { verticalForBusinessType } from '../../../shared/checklistPresetDerivation';
import { errorsTotal } from '../metrics';

export async function copyBusinessTemplate(
  client: PoolClient,
  tenantId: string,
  businessType: string | null | undefined
): Promise<boolean> {
  const vertical = verticalForBusinessType(businessType);
  await client.query('SAVEPOINT business_template_copy');
  try {
    const res = await client.query<{ copied: boolean }>(
      'SELECT copy_business_template_to_tenant($1, $2) AS copied',
      [tenantId, vertical]
    );
    await client.query('RELEASE SAVEPOINT business_template_copy');
    return res.rows[0]?.copied === true;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT business_template_copy');
    errorsTotal.inc({ event: 'business_template_copy_failed' });
    console.warn(
      `[businessTemplate] template copy failed for tenant ${tenantId} ` +
        `(business_type=${businessType}, vertical=${vertical}); business starts empty:`,
      err
    );
    return false;
  }
}
