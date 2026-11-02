export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

export function whatsappMessagesUrl(baseUrl: string, phoneNumberId: string): string {
  return joinUrl(baseUrl, `${phoneNumberId.replace(/^\//, '')}/messages`);
}

export function normalizeMsisdn(
  phone: string,
  countryPrefix: string | null | undefined,
): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  const prefix = (countryPrefix ?? '').replace(/\D/g, '');
  if (prefix && digits.length <= 10) return `${prefix}${digits}`;
  return digits;
}

export function whatsappMediaUrl(baseUrl: string, phoneNumberId: string): string {
  return joinUrl(baseUrl, `${phoneNumberId.replace(/^\//, '')}/media`);
}

export function whatsappDocumentPayload(
  to: string,
  mediaId: string,
  filename: string,
  caption: string,
) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'document',
    document: {
      id: mediaId,
      filename,
      caption: caption.slice(0, 1024),
    },
  };
}

export function whatsappImagePayload(to: string, mediaId: string, caption: string) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'image',
    image: { id: mediaId, caption: caption.slice(0, 1024) },
  };
}

export function whatsappCatalogMessagePayload(to: string, body: string) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'catalog_message',
      body: { text: body.slice(0, 1024) },
      action: { name: 'catalog_message' },
    },
  };
}

export function whatsappTextPayload(to: string, body: string) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body },
  };
}

export function whatsappTemplatePayload(
  to: string,
  name: string,
  language: string,
  body: string,
) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: { code: language },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: body.slice(0, 1024) }],
        },
      ],
    },
  };
}
