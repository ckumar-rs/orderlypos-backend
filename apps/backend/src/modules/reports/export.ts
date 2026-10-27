import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { toCsv, type CsvValue } from './csv';
import type { ReportResult } from './reports.service';

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export const EXPORT_TYPES: Record<ExportFormat, { mime: string; ext: string }> =
  {
    csv: { mime: 'text/csv; charset=utf-8', ext: 'csv' },
    xlsx: {
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ext: 'xlsx',
    },
    pdf: { mime: 'application/pdf', ext: 'pdf' },
  };

export function isExportFormat(v: string): v is ExportFormat {
  return v === 'csv' || v === 'xlsx' || v === 'pdf';
}

const FORMULA_START = /^[=+\-@\t\r]/;

function cell(v: CsvValue): string | number | boolean | Date | null {
  if (v == null) return null;
  // Same spreadsheet-injection guard as the CSV writer.
  if (typeof v === 'string' && FORMULA_START.test(v)) return `'${v}`;
  return v;
}

export async function buildXlsx(
  r: ReportResult,
  subtitle: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OrderlyPOS';
  const ws = wb.addWorksheet(r.title.slice(0, 31));
  ws.addRow([r.title]).font = { bold: true, size: 14 };
  ws.addRow([subtitle]).font = { color: { argb: 'FF666666' } };
  ws.addRow([]);
  const head = ws.addRow(r.columns);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => {
    c.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF7A1F3D' },
    };
  });
  for (const row of r.rows) ws.addRow(row.map(cell));
  r.columns.forEach((name, i) => {
    const widest = Math.max(
      name.length,
      ...r.rows.slice(0, 200).map((row) => String(row[i] ?? '').length),
    );
    ws.getColumn(i + 1).width = Math.min(48, Math.max(10, widest + 2));
  });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function buildPdf(r: ReportResult, subtitle: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: r.columns.length > 6 ? 'landscape' : 'portrait',
      margin: 36,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width - 72;
    const colW = pageW / Math.max(1, r.columns.length);
    const fmt = (v: CsvValue) =>
      v == null
        ? ''
        : v instanceof Date
          ? v.toISOString().slice(0, 10)
          : typeof v === 'number'
            ? String(Math.round(v * 100) / 100)
            : String(v);

    doc.fontSize(16).font('Helvetica-Bold').text(r.title);
    doc.fontSize(9).font('Helvetica').fillColor('#666666').text(subtitle);
    doc.moveDown(0.8);

    const drawRow = (vals: string[], bold: boolean) => {
      const y = doc.y;
      if (y > doc.page.height - 60) {
        doc.addPage();
        drawRow(r.columns, true);
        return;
      }
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8.5)
        .fillColor('#000000');
      let h = 0;
      vals.forEach((v, i) => {
        const t = doc.heightOfString(v, { width: colW - 6 });
        h = Math.max(h, t);
        doc.text(v, 36 + i * colW, y, { width: colW - 6, lineBreak: true });
      });
      doc.y = y + h + 4;
      doc
        .moveTo(36, doc.y - 2)
        .lineTo(36 + pageW, doc.y - 2)
        .strokeColor(bold ? '#7A1F3D' : '#dddddd')
        .lineWidth(bold ? 1 : 0.5)
        .stroke();
    };

    drawRow(r.columns, true);
    for (const row of r.rows) drawRow(row.map(fmt), false);
    if (!r.rows.length) {
      doc
        .moveDown()
        .fontSize(10)
        .fillColor('#666666')
        .text('No data for this period.');
    }
    doc.end();
  });
}

export async function renderReport(
  r: ReportResult,
  format: ExportFormat,
  subtitle: string,
): Promise<Buffer> {
  if (format === 'csv') return Buffer.from(toCsv(r.columns, r.rows), 'utf8');
  if (format === 'xlsx') return buildXlsx(r, subtitle);
  return buildPdf(r, subtitle);
}
