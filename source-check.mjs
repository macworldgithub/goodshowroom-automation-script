import { lookup } from 'node:dns/promises';

// Connectivity only: no browser state, credentials or customer records are read.
try {
  const source = new URL(process.env.ERAPOWER_URL);
  if (source.protocol !== 'https:' || source.username || source.password) throw new Error('INVALID_SOURCE_URL');
  const addresses = await lookup(source.hostname, { all: true });
  console.log(JSON.stringify({ event: 'source_dns_check', hostname: source.hostname, reachableByDns: addresses.length > 0 }));
} catch (error) {
  console.error(JSON.stringify({ event: 'source_dns_check_failed', code: ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code) ? 'SOURCE_DNS_UNRESOLVED' : 'CHECK_SOURCE_URL_AND_NETWORK' }));
  process.exitCode = 1;
}
