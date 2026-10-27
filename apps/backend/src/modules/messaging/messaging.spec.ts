import {
  normalizeMsisdn,
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
