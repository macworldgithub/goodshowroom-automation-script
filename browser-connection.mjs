export function localBrowserEndpoint(value = 'http://127.0.0.1:9223') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('BROWSER_ENDPOINT_MUST_BE_LOCAL');
  }
  return url;
}
