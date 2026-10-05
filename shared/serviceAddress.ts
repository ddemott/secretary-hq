/**
 * Service address — where a business USES the service, for sales-tax calculation.
 *
 * SaaS sales tax follows where the customer uses the service, not where we are, so every business
 * gives us a street / city / state / zip at signup and Stripe Tax prices the sale from it. Pure and
 * framework-free so the backend (/register, owner edit) and the dashboard form agree byte-for-byte
 * on what a valid address is. The DB repeats the format rules as CHECK constraints
 * (migration 20261005000000) as a last line of defence.
 *
 * US only for now: the product sells to US service businesses.
 */

export const US_STATE_CODES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
] as const;

export type ServiceAddressField = 'street' | 'city' | 'state' | 'zip';

export interface ServiceAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export type ServiceAddressResult =
  | { ok: true; address: ServiceAddress }
  | { ok: false; errors: Partial<Record<ServiceAddressField, string>> };

const ZIP_RE = /^[0-9]{5}(-[0-9]{4})?$/;
const MAX_LEN = 200;

const tidy = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/**
 * Trim, collapse whitespace, upper-case the state, and check every part. Returns the cleaned
 * address or a message per bad field. A missing field is an error: there is no "partial" address.
 */
export function normalizeServiceAddress(
  input: Partial<Record<ServiceAddressField, unknown>> | null | undefined
): ServiceAddressResult {
  const street = tidy(input?.street);
  const city = tidy(input?.city);
  const state = tidy(input?.state).toUpperCase();
  const zip = tidy(input?.zip);

  const errors: Partial<Record<ServiceAddressField, string>> = {};
  if (!street) errors.street = 'Enter the street address.';
  else if (street.length > MAX_LEN) errors.street = 'That street address is too long.';
  if (!city) errors.city = 'Enter the city.';
  else if (city.length > MAX_LEN) errors.city = 'That city name is too long.';
  if (!state) errors.state = 'Choose the state.';
  else if (!(US_STATE_CODES as readonly string[]).includes(state))
    errors.state = 'Use a two-letter US state code, like IL.';
  if (!zip) errors.zip = 'Enter the zip code.';
  else if (!ZIP_RE.test(zip)) errors.zip = 'Use a 5-digit zip code, like 60602.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, address: { street, city, state, zip } };
}
