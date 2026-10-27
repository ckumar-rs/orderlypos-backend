/** Period yield: theoretical (recipe on paid bills) vs what left the pantry. */
export function computeYieldRow(input: {
  opening: number;
  receipts: number;
  reversals: number;
  theoretical: number;
  productionOut: number;
  waste: number;
  closing: number;
  costPerUnit: number;
}) {
  const actualUsage = round3(
    input.opening + input.receipts + input.reversals - input.closing,
  );
  const explained = round3(
    input.theoretical + input.productionOut + input.waste,
  );
  const unexplained = round3(actualUsage - explained);
  const wastePct =
    actualUsage > 0 ? round2((input.waste / actualUsage) * 100) : 0;
  const yieldPct =
    actualUsage > 0 ? round2((input.theoretical / actualUsage) * 100) : 0;
  const unexplainedPct =
    actualUsage > 0 ? round2((unexplained / actualUsage) * 100) : 0;
  return {
    opening: input.opening,
    receipts: input.receipts,
    reversals: input.reversals,
    closing: input.closing,
    theoretical: input.theoretical,
    productionOut: input.productionOut,
    waste: input.waste,
    actualUsage,
    explained,
    unexplained,
    wastePct,
    yieldPct,
    unexplainedPct,
    yieldLoss: round3(Math.max(0, unexplained)),
    unexplainedCost: round2(unexplained * input.costPerUnit),
    wasteCost: round2(input.waste * input.costPerUnit),
  };
}

export function computePpvLine(
  qty: number,
  actual: number,
  po?: number | null,
  quoted?: number | null,
) {
  return {
    qty,
    actual,
    po: po ?? null,
    quoted: quoted ?? null,
    varianceVsPo: po == null ? null : round2((actual - po) * qty),
    varianceVsQuote: quoted == null ? null : round2((actual - quoted) * qty),
    pctVsPo: po && po !== 0 ? round2(((actual - po) / po) * 100) : null,
    pctVsQuote:
      quoted && quoted !== 0 ? round2(((actual - quoted) / quoted) * 100) : null,
  };
}

export function scalePrepInputs(
  outputQuantity: number,
  inputs: { ingredientId: string; quantity: number }[],
  batchMultiplier: number,
) {
  if (outputQuantity <= 0) {
    throw new Error('outputQuantity must be positive');
  }
  if (batchMultiplier <= 0) {
    throw new Error('batchMultiplier must be positive');
  }
  return {
    theoreticalOutput: round3(outputQuantity * batchMultiplier),
    inputs: inputs.map((line) => ({
      ingredientId: line.ingredientId,
      quantity: round3(line.quantity * batchMultiplier),
    })),
  };
}

export function prepYieldPct(
  theoreticalOutput: number,
  actualOutput: number,
) {
  return theoreticalOutput > 0
    ? round2((actualOutput / theoreticalOutput) * 100)
    : 0;
}

export function periodBounds(from?: string, to?: string) {
  const end = to ? new Date(`${to}T23:59:59.999`) : new Date();
  const start = from
    ? new Date(`${from}T00:00:00.000`)
    : new Date(end.getTime() - 7 * 86_400_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Use dates as YYYY-MM-DD');
  }
  if (start > end) throw new Error('from must be on or before to');
  return { start, end };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
