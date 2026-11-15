export interface Admission {
  readonly committedUsd: number;
  readonly reservedUsd: number;
  readonly reservation: number;
  readonly jobCapUsd: number;
  readonly accountCapUsd: number;
}
export function admit(input: Admission): boolean {
  return (
    Object.values(input).every((n) => Number.isFinite(n) && n >= 0) &&
    input.committedUsd + input.reservedUsd + input.reservation <=
      Math.min(input.jobCapUsd, input.accountCapUsd)
  );
}
export interface Pricing {
  readonly highestRecordedUsdPerSecond: number;
  readonly outputUsdPerToken: number;
}
export function reservationFor(
  model: string,
  videoSeconds: number,
  maxTokens: number,
  pricing: Pricing,
): number {
  if (model.endsWith(":free")) return 0;
  if (
    ![videoSeconds, maxTokens, ...Object.values(pricing)].every((n) => Number.isFinite(n) && n >= 0)
  )
    throw new RangeError("Invalid reservation inputs");
  return videoSeconds * pricing.highestRecordedUsdPerSecond + maxTokens * pricing.outputUsdPerToken;
}
