/**
 * All errors thrown by this package derive from `MoneyError`, so callers can
 * distinguish a domain failure from a programming bug without string matching.
 */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when an operation combines two different currencies. */
export class CurrencyMismatchError extends MoneyError {
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(
      `Cannot combine ${left} and ${right}. Convert to a common currency first.`,
    );
  }
}

/** Thrown when a currency code is not present in the registry. */
export class UnknownCurrencyError extends MoneyError {
  constructor(readonly code: string) {
    super(`Unknown currency code: ${code}`);
  }
}

/** Thrown when a string cannot be parsed as an exact decimal. */
export class ParseError extends MoneyError {
  constructor(readonly input: string, reason: string) {
    super(`Cannot parse ${JSON.stringify(input)}: ${reason}`);
  }
}

/** Thrown when a divisor is zero. */
export class DivisionByZeroError extends MoneyError {
  constructor() {
    super("Division by zero");
  }
}

/** Thrown when allocation ratios are invalid. */
export class AllocationError extends MoneyError {}
