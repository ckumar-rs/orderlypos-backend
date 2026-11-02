import {
  normalizeMsisdn,
  whatsappCatalogMessagePayload,
  whatsappDocumentPayload,
  whatsappImagePayload,
  whatsappMediaUrl,
  whatsappMessagesUrl,
  whatsappTemplatePayload,
  whatsappTextPayload,
} from './messaging';

describe('messaging urls and phones', () => {
  it('joins the stored Cloud API base with the phone-number messages path', () => {
    expect(
      whatsappMessagesUrl('https://graph.example.com/v21.0/', '123456'),
    ).toBe('https://graph.example.com/v21.0/123456/messages');
  });

  it('prepends a stored country prefix only for local-length numbers', () => {
    expect(normalizeMsisdn('9618613439', '91')).toBe('919618613439');
    expect(normalizeMsisdn('+91 96186 13439', '91')).toBe('919618613439');
    expect(normalizeMsisdn('9618613439', '')).toBe('9618613439');
    expect(normalizeMsisdn('12', '91')).toBeNull();
  });

  it('builds a Cloud API image message for an uploaded UPI QR', () => {
    expect(whatsappMediaUrl('https://graph.example.com/v21.0/', '123456')).toBe(
      'https://graph.example.com/v21.0/123456/media',
    );
    expect(whatsappImagePayload('919876543210', 'media-1', 'Scan to pay')).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'image',
      image: { id: 'media-1', caption: 'Scan to pay' },
    });
    expect(whatsappDocumentPayload('919876543210', 'media-2', 'receipt-12.pdf', 'Receipt 12')).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'document',
      document: { id: 'media-2', filename: 'receipt-12.pdf', caption: 'Receipt 12' },
    });
  });

  it('builds a Cloud API catalog message for an open customer chat', () => {
    expect(whatsappCatalogMessagePayload('919876543210', 'Browse the menu')).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'interactive',
      interactive: {
        type: 'catalog_message',
        body: { text: 'Browse the menu' },
        action: { name: 'catalog_message' },
      },
    });
  });

  it('builds the official Cloud API text envelope', () => {
    expect(whatsappTextPayload('919618613439', 'Hello')).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919618613439',
      type: 'text',
      text: { preview_url: false, body: 'Hello' },
    });
  });

  it('builds a template envelope with one body parameter', () => {
    const payload = whatsappTemplatePayload(
      '919618613439',
      'receipt',
      'en',
      'Bill 12',
    );
    expect(payload.type).toBe('template');
    expect(payload.template.name).toBe('receipt');
    expect(payload.template.language).toEqual({ code: 'en' });
  });
});
