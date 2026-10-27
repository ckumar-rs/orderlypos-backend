import { chatCompletionsUrl } from './ai-chat';

describe('chatCompletionsUrl', () => {
  it('appends /chat/completions once', () => {
    expect(chatCompletionsUrl('https://router.huggingface.co/v1/')).toBe(
      'https://router.huggingface.co/v1/chat/completions',
    );
    expect(
      chatCompletionsUrl('https://integrate.api.nvidia.com/v1/chat/completions'),
    ).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
  });
});
