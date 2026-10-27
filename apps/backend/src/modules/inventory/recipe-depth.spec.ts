import { nextAlertTier } from './alert-tier';
import { anomaly } from './anomaly';
import { menuEngineering } from './menu-engineering';
import { salePortionFactor, violatesPortionStep } from './portion';
import { recipeCost } from './recipe-cost';
import { convertQuantity } from './unit-convert';

describe('convertQuantity', () => {
  it('converts the built-in kitchen units', () => {
    expect(convertQuantity(2, 'KG', 'G')).toBe(2000);
    expect(convertQuantity(500, 'ML', 'L')).toBe(0.5);
    expect(convertQuantity(24, 'PIECE', 'DOZEN')).toBe(2);
  });

  it('walks a pack through pieces into dozens', () => {
    const custom = [{ fromUnit: 'PACK', toUnit: 'PIECE', factor: 6 }];
    expect(convertQuantity(2, 'PACK', 'DOZEN', custom)).toBe(1);
  });

  it('refuses a mass to count conversion', () => {
    expect(convertQuantity(1, 'KG', 'PIECE')).toBeNull();
  });
});

describe('recipeCost', () => {
  it('splits a batch across its servings and yield', () => {
    expect(recipeCost([{ quantity: 200, costPerUnit: 2 }], 4, 8)).toEqual({
      batchCost: 400,
      servings: 4,
      perServing: 100,
      perYield: 50,
    });
  });
});

describe('portion', () => {
  it('halves a serving and rejects a quantity off the step', () => {
    expect(salePortionFactor('HALF')).toBe(0.5);
    expect(salePortionFactor('FULL')).toBe(1);
    expect(violatesPortionStep(1.5, 1)).toBe(true);
    expect(violatesPortionStep(1, 0.5)).toBe(false);
  });
});

describe('menuEngineering', () => {
  it('splits dishes by popularity and margin', () => {
    const rows = menuEngineering([
      { id: 'a', name: 'Burger', sold: 40, price: 200, foodCost: 40 },
      { id: 'b', name: 'Soup', sold: 40, price: 80, foodCost: 70 },
      { id: 'c', name: 'Steak', sold: 4, price: 500, foodCost: 100 },
      { id: 'd', name: 'Salad', sold: 4, price: 90, foodCost: 80 },
    ]);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row.menuClass]));
    expect(byName).toEqual({
      Burger: 'STAR',
      Soup: 'PLOWHORSE',
      Steak: 'PUZZLE',
      Salad: 'DOG',
    });
    expect(rows.find((row) => row.name === 'Burger')?.contribution).toBe(6400);
  });
});

describe('anomaly', () => {
  it('flags a day far above a steady baseline', () => {
    const result = anomaly([10, 10, 11, 9, 10, 40]);
    expect(result?.flagged).toBe(true);
    expect(result?.zScore).toBeGreaterThanOrEqual(2);
  });

  it('stays quiet when today matches the baseline', () => {
    expect(anomaly([10, 10, 10, 10, 10, 10])?.flagged).toBe(false);
  });
});

describe('nextAlertTier', () => {
  it('pushes, then emails, then escalates', () => {
    expect(nextAlertTier(null, 0)).toBe('PUSH');
    expect(nextAlertTier('PUSH', 10)).toBeNull();
    expect(nextAlertTier('PUSH', 24)).toBe('EMAIL');
    expect(nextAlertTier('EMAIL', 48)).toBe('ESCALATE');
    expect(nextAlertTier('ESCALATE', 100)).toBeNull();
  });
});
