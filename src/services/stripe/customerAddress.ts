/**
 * The tenant's service address, shaped for Stripe.
 *
 * Stripe Tax prices every invoice from the customer's address, and SaaS tax follows where the
 * service is USED, so this is the business's service address (tenants.service_*), not a billing one.
 * Null when the business has not given a full address — callers decide whether that blocks checkout.
 */
import type Stripe from 'stripe';

export interface TenantServiceAddressRow {
  service_street?: string | null;
  service_city?: string | null;
  service_state?: string | null;
  service_zip?: string | null;
  service_country?: string | null;
}

export function stripeCustomerAddress(row: TenantServiceAddressRow): Stripe.AddressParam | null {
  const { service_street, service_city, service_state, service_zip } = row;
  if (!service_street || !service_city || !service_state || !service_zip) return null;
  return {
    line1: service_street,
    city: service_city,
    state: service_state,
    postal_code: service_zip,
    country: row.service_country || 'US',
  };
}
