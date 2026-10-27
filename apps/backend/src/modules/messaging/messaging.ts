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
