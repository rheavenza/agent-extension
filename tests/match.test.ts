import { describe, expect, it } from 'vitest';
import { matchPatternToRegExp, originToPattern, urlMatchesAny } from '../lib/match';

describe('match patterns', () => {
  it('matches subdomain wildcards', () => {
    const p = ['https://*.service-now.com/*'];
    expect(urlMatchesAny('https://acme.service-now.com/incident.do', p)).toBe(true);
    expect(urlMatchesAny('https://service-now.com/x', p)).toBe(true);
    expect(urlMatchesAny('https://acme.service-now.com.evil.io/x', p)).toBe(false);
    expect(urlMatchesAny('http://acme.service-now.com/x', p)).toBe(false);
  });
  it('matches ports and explicit hosts', () => {
    expect(urlMatchesAny('https://splunk.corp:8000/en-US/app/search', ['https://splunk.corp/*'])).toBe(true);
    expect(urlMatchesAny('https://splunk.corp:8000/en-US', ['https://splunk.corp:8000/*'])).toBe(true);
  });
  it('rejects invalid patterns', () => {
    expect(matchPatternToRegExp('nope')).toBeNull();
  });
  it('turns origins into patterns', () => {
    expect(originToPattern('https://acme.service-now.com')).toBe('https://acme.service-now.com/*');
    expect(originToPattern('splunk.corp.example.com')).toBe('https://splunk.corp.example.com/*');
    expect(originToPattern('https://*.splunkcloud.com/*')).toBe('https://*.splunkcloud.com/*');
    expect(originToPattern('')).toBeNull();
  });
});
