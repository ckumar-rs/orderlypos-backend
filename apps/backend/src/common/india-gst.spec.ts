import { branchGstState, gstStateCode, inclusiveGstLine, indiaPlaceOfSupply, isUnionTerritoryWithoutLegislature, splitIndiaGst } from './india-gst';

describe('India GST place of supply', () => {
  it('uses IGST when the guest state differs', () => {
    const supply = indiaPlaceOfSupply('36', '07');
    expect(supply.interstate).toBe(true);
    expect(splitIndiaGst(18, supply)).toEqual({ cgst: 0, sgst: 0, utgst: 0, igst: 18 });
  });

  it('uses CGST and UTGST for a walk-in in Chandigarh', () => {
    const supply = indiaPlaceOfSupply('04', null);
    expect(supply.intraUt).toBe(true);
    expect(isUnionTerritoryWithoutLegislature('4')).toBe(true);
    expect(splitIndiaGst(10.01, supply)).toEqual({ cgst: 5.01, sgst: 0, utgst: 5, igst: 0 });
  });

  it('keeps Delhi on CGST and SGST and reads a GSTIN prefix', () => {
    expect(indiaPlaceOfSupply('07', '07').intraUt).toBe(false);
    expect(splitIndiaGst(18, indiaPlaceOfSupply('07', ''))).toEqual({ cgst: 9, sgst: 9, utgst: 0, igst: 0 });
    expect(gstStateCode('36AAAAA0000A1Z5')).toBe('36');
    expect(gstStateCode('28AAAAA0000A1Z5')).toBe('37');
    expect(branchGstState('', '04AAAAA0000A1Z5')).toBe('04');
    expect(indiaPlaceOfSupply(branchGstState('', '04AAAAA0000A1Z5'), null).intraUt).toBe(true);
  });

  it('backs GST out of an inclusive restaurant price', () => {
    expect(inclusiveGstLine(118, 18)).toEqual({ taxable: 100, tax: 18 });
    expect(inclusiveGstLine(105, 5)).toEqual({ taxable: 100, tax: 5 });
  });
});
