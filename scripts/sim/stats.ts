/** Nearest-rank percentile of `values` (0 < p <= 100). NaN when empty. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export type Summary = {
  count: number;
  p50: number;
  p95: number;
  max: number;
};

export function summarize(values: readonly number[]): Summary {
  let max = NaN;
  for (const v of values) if (!(v <= max)) max = v;
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max,
  };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function ms(value: number, digits = 1): string {
  return Number.isFinite(value) ? `${value.toFixed(digits)} ms` : "n/a";
}
