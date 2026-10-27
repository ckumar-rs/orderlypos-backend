import { AeatFault, parseResponse } from './verifactu.aeat';

const ok = `<?xml version="1.0"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body>
<tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="x" xmlns:tik="y"><tikR:CSV>ABC123</tikR:CSV><tikR:TiempoEsperaEnvio>60</tikR:TiempoEsperaEnvio><tikR:EstadoEnvio>ParcialmenteCorrecto</tikR:EstadoEnvio>
<tikR:RespuestaLinea><tikR:IDFactura><tik:IDEmisorFactura>B12345678</tik:IDEmisorFactura><tik:NumSerieFactura>T1-000001</tik:NumSerieFactura><tik:FechaExpedicionFactura>02-07-2024</tik:FechaExpedicionFactura></tikR:IDFactura><tikR:Operacion><tik:TipoOperacion>Alta</tik:TipoOperacion></tikR:Operacion><tikR:EstadoRegistro>Correcto</tikR:EstadoRegistro></tikR:RespuestaLinea>
<tikR:RespuestaLinea><tikR:IDFactura><tik:IDEmisorFactura>B12345678</tik:IDEmisorFactura><tik:NumSerieFactura>T1-000002</tik:NumSerieFactura><tik:FechaExpedicionFactura>02-07-2024</tik:FechaExpedicionFactura></tikR:IDFactura><tikR:Operacion><tik:TipoOperacion>Alta</tik:TipoOperacion></tikR:Operacion><tikR:EstadoRegistro>Incorrecto</tikR:EstadoRegistro><tikR:CodigoErrorRegistro>1100</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>Valor &quot;x&quot; no válido</tikR:DescripcionErrorRegistro></tikR:RespuestaLinea>
</tikR:RespuestaRegFactuSistemaFacturacion></env:Body></env:Envelope>`;

describe('parseResponse', () => {
  it('reads the submission state, wait time and every record line', () => {
    const r = parseResponse(200, ok);
    expect(r.csv).toBe('ABC123');
    expect(r.state).toBe('ParcialmenteCorrecto');
    expect(r.waitSeconds).toBe(60);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({
      number: 'T1-000001',
      operation: 'Alta',
      state: 'Correcto',
    });
    expect(r.lines[1]).toMatchObject({
      number: 'T1-000002',
      state: 'Incorrecto',
      errorCode: '1100',
      errorText: 'Valor "x" no válido',
    });
  });
  it('raises a SOAP fault', () => {
    const fault =
      '<s:Envelope xmlns:s="x"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>Certificado no válido</faultstring></s:Fault></s:Body></s:Envelope>';
    expect(() => parseResponse(500, fault)).toThrow(AeatFault);
  });
  it('rejects an unreadable answer', () => {
    expect(() => parseResponse(502, '<html>Bad gateway</html>')).toThrow(
      /HTTP 502/,
    );
  });
});
