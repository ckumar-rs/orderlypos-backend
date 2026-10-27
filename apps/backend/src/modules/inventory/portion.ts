/** Half a plate consumes half a serving. Any other portion keeps a full serving. */
export function salePortionFactor(portion?: string | null) {
  return portion === 'HALF' ? 0.5 : 1;
}

/** True when `quantity` is not a whole number of `step` units. */
export function violatesPortionStep(quantity: number, step: number) {
  if (!(step > 0) || !(quantity > 0)) return false;
  const steps = quantity / step;
  return Math.abs(steps - Math.round(steps)) > 0.001;
}
