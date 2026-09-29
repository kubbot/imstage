/**
 * Centralised public configuration.
 *
 * VITE_BUSINESS_EMAIL: the verified business contact for separately licensed
 * commercial (closed-source dataset / evaluation) services. No address is
 * invented: until the owner provides and verifies one, `BUSINESS_EMAIL` stays
 * empty and every surface shows an honest "not published yet" state.
 */
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const raw: string = (env.VITE_BUSINESS_EMAIL ?? '').trim();

export const BUSINESS_EMAIL = raw;

export const businessEmailAvailable: boolean = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(raw);
