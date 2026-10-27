import { hashEmail, openCustomerFields, openText, sealCustomerFields, sealText } from './field-seal';

const KEY = 'test-key';

describe('customer field seal', () => {
  it('seals and opens the sensitive fields, and keeps a lookup for email', () => {
    const sealed = sealCustomerFields(
      { email: 'Guest@Example.com', address: '12 Hill Road', notes: 'window', allergies: 'nuts', name: 'Asha' },
      KEY,
    );
    expect(sealed.email?.startsWith('v1.')).toBe(true);
    expect(sealed.address?.startsWith('v1.')).toBe(true);
    expect(sealed.notes?.startsWith('v1.')).toBe(true);
    expect(sealed.allergies?.startsWith('v1.')).toBe(true);
    expect(sealed.name).toBe('Asha');
    expect(sealed.emailLookup).toBe(hashEmail('guest@example.com'));
    const opened = openCustomerFields(sealed, KEY);
    expect(opened.email).toBe('Guest@Example.com');
    expect(opened.address).toBe('12 Hill Road');
    expect(openText('plain', KEY)).toBe('plain');
  });
});
