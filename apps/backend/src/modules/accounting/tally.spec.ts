import {
  parseTallyXmlResult,
  tallyLiveImportXml,
  tallyServerUrl,
  tallyVoucherXml,
} from './tally';

describe('Tally export', () => {
  it('writes an import envelope with a sales voucher', () => {
    const xml = tallyVoucherXml('ABA', [
      {
        date: '2026-10-26T00:00:00.000Z',
        number: '20261026-0001',
        narration: 'Sale 20261026-0001',
        type: 'Sales',
        amount: 320,
        ledger: 'UPI',
      },
    ]);
    expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(xml).toContain('<SVCURRENTCOMPANY>ABA</SVCURRENTCOMPANY>');
    expect(xml).toContain('<LEDGERNAME>UPI</LEDGERNAME>');
    expect(xml).toContain('<LEDGERNAME>Sales</LEDGERNAME>');
    expect(xml).toContain('<AMOUNT>-320.00</AMOUNT>');
    expect(xml).toContain('<DATE>20261026</DATE>');
  });

  it('builds the XML Server import envelope', () => {
    const xml = tallyLiveImportXml('ABA', [
      {
        date: '2026-10-26',
        number: '1',
        narration: 'Sale',
        type: 'Sales',
        amount: 10,
        ledger: 'Cash',
      },
    ]);
    expect(xml).toContain('<TALLYREQUEST>Import</TALLYREQUEST>');
    expect(xml).toContain('<ID>Vouchers</ID>');
  });

  it('builds a LAN URL from stored host and port', () => {
    expect(tallyServerUrl('192.168.1.20', 9000)).toBe('http://192.168.1.20:9000');
    expect(() => tallyServerUrl('http://evil', 9000)).toThrow(/host/);
  });

  it('reads a successful Tally import result', () => {
    expect(
      parseTallyXmlResult('<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><CREATED>2</CREATED></ENVELOPE>'),
    ).toMatchObject({ ok: true, created: 2 });
  });
});
