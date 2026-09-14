import { UnknownCurrencyError } from "./errors.js";

/**
 * Number of decimal places every `Money` value is stored at internally.
 *
 * Four is chosen deliberately: it is greater than the minor-unit scale of every
 * circulating currency (the maximum is 3, for KWD/BHD/TND/OMR/JOD), so no
 * currency loses precision at rest, and it leaves headroom for intermediate
 * results such as per-unit prices and withholding rates.
 *
 * Postgres columns storing money must be declared `NUMERIC(19, 4)` to match.
 */
export const MONEY_SCALE = 4;

export interface Currency {
  /** ISO 4217 alphabetic code. */
  readonly code: string;
  /** Minor units per major unit, as a power of ten (USD: 2, JPY: 0, KWD: 3). */
  readonly decimals: number;
  readonly symbol: string;
  readonly name: string;
}

/**
 * Currencies known to the system. Deliberately small: entries are added when a
 * feature needs them, so an unrecognised code fails loudly rather than silently
 * defaulting to two decimal places and corrupting JPY or KWD amounts.
 */
const REGISTRY = new Map<string, Currency>();

function register(currency: Currency): Currency {
  REGISTRY.set(currency.code, currency);
  return currency;
}

export const USD = register({ code: "USD", decimals: 2, symbol: "$", name: "US Dollar" });
export const EUR = register({ code: "EUR", decimals: 2, symbol: "€", name: "Euro" });
export const GBP = register({ code: "GBP", decimals: 2, symbol: "£", name: "Pound Sterling" });
export const CAD = register({ code: "CAD", decimals: 2, symbol: "$", name: "Canadian Dollar" });
export const AUD = register({ code: "AUD", decimals: 2, symbol: "$", name: "Australian Dollar" });
export const CHF = register({ code: "CHF", decimals: 2, symbol: "Fr", name: "Swiss Franc" });
export const JPY = register({ code: "JPY", decimals: 0, symbol: "¥", name: "Japanese Yen" });
export const KWD = register({ code: "KWD", decimals: 3, symbol: "د.ك", name: "Kuwaiti Dinar" });

/** Register an additional currency at runtime (used by tests and imports). */
export function registerCurrency(currency: Currency): Currency {
  if (currency.decimals < 0 || currency.decimals > MONEY_SCALE) {
    throw new RangeError(
      `Currency ${currency.code} declares ${currency.decimals} decimals, ` +
        `which exceeds the internal scale of ${MONEY_SCALE}.`,
    );
  }
  return register(currency);
}

export function getCurrency(code: string): Currency {
  const found = REGISTRY.get(code);
  if (!found) throw new UnknownCurrencyError(code);
  return found;
}

export function isKnownCurrency(code: string): boolean {
  return REGISTRY.has(code);
}

/** All registered currency codes, sorted for stable output. */
export function knownCurrencyCodes(): string[] {
  return [...REGISTRY.keys()].sort();
}
