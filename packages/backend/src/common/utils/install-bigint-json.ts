/**
 * Side-effect module: installs a global `BigInt.prototype.toJSON` so BigInt
 * values (e.g. from Prisma BigInt fields) can be serialised to JSON without
 * throwing "Do not know how to serialize a BigInt".
 *
 * MUST be imported once, as early as possible, in EVERY process entry point
 * (API server AND BullMQ worker). The worker previously lacked this, so every
 * JSON.stringify of a BigInt inside the order-sync processor threw and failed
 * the order — the single largest source of sync failures.
 *
 * A runtime guard protects against silent precision loss: any BigInt that
 * exceeds Number.MAX_SAFE_INTEGER would lose digits when coerced to a JS
 * number, so we throw early rather than silently corrupt data. All Oracle
 * account IDs used in this application are well within Number.MAX_SAFE_INTEGER
 * (9,007,199,254,740,991).
 */
(BigInt.prototype as { toJSON?: () => number }).toJSON = function (
  this: bigint,
) {
  const n = this.valueOf();
  if (
    n > BigInt(Number.MAX_SAFE_INTEGER) ||
    n < BigInt(-Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError(
      `BigInt value ${n.toString()} cannot be safely serialised as a JSON number (exceeds MAX_SAFE_INTEGER)`,
    );
  }
  return Number(n);
};
