export interface TallyVoucher {
  date: string;
  number: string;
  narration: string;
  type: 'Sales' | 'Payment';
  amount: number;
  ledger: string;
}

function xml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ymd(isoDate: string) {
  return isoDate.slice(0, 10).replace(/-/g, '');
}

/**
 * TallyPrime voucher import. Sales debit the named ledger (Cash, Card, UPI)
 * and credit Sales. Expenses debit the category and credit Cash.
 * Amounts use Tally's sign: the deemed-positive side is negative.
 */
export function tallyVoucherXml(companyName: string, vouchers: TallyVoucher[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xml(companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${voucherMessages(vouchers)}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
}

export function connectorJson(companyName: string, vouchers: TallyVoucher[]) {
  return {
    format: 'nodedr-accounting-vouchers',
    companyName,
    note: 'Same figures as the Tally XML. Import into another ledger by mapping type, ledger, and amount.',
    vouchers,
  };
}

function voucherMessages(vouchers: TallyVoucher[]) {
  return vouchers
    .map((voucher) => {
      const amount = voucher.amount.toFixed(2);
      const debit = voucher.ledger;
      const credit = voucher.type === 'Sales' ? 'Sales' : 'Cash';
      return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${voucher.type}" ACTION="Create">
            <DATE>${ymd(voucher.date)}</DATE>
            <VOUCHERTYPENAME>${voucher.type}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xml(voucher.number)}</VOUCHERNUMBER>
            <NARRATION>${xml(voucher.narration)}</NARRATION>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xml(debit)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${amount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xml(credit)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${amount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>`;
    })
    .join('\n');
}

/** Official Tally XML Server import envelope (Tally as HTTP server).
 * Source: https://help.tallysolutions.com/xml-integration/ */
export function tallyLiveImportXml(companyName: string, vouchers: TallyVoucher[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${xml(companyName)}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
    </DESC>
    <DATA>
${voucherMessages(vouchers)}
    </DATA>
  </BODY>
</ENVELOPE>
`;
}

/** Export ping so we can see the XML Server before posting vouchers. */
export function tallyPingXml(companyName?: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Companies</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${companyName ? `<SVCURRENTCOMPANY>${xml(companyName)}</SVCURRENTCOMPANY>` : ''}
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>
`;
}

export function tallyServerUrl(host: string, port: number, useHttps = false) {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error('Tally host must be an IP address or host name');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Tally port is invalid');
  }
  return `${useHttps ? 'https' : 'http'}://${host}:${port}`;
}

export function parseTallyXmlResult(body: string) {
  const status = /<STATUS>(\d+)<\/STATUS>/i.exec(body)?.[1];
  const created = /<CREATED>(\d+)<\/CREATED>/i.exec(body)?.[1];
  const errors = /<ERRORS>(\d+)<\/ERRORS>/i.exec(body)?.[1];
  const lineError = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(body)?.[1];
  const createdN = created == null ? null : Number(created);
  const errorsN = errors == null ? null : Number(errors);
  const ok =
    status === '1' ||
    (createdN != null && createdN > 0 && (errorsN ?? 0) === 0);
  return {
    ok,
    status: status ?? null,
    created: createdN,
    errors: errorsN,
    message: lineError?.replace(/<[^>]+>/g, '').trim() || null,
  };
}
