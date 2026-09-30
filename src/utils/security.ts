import { URL } from 'url';

/**
 * Validates whether a target URL is safe to fetch or violates SSRF policies
 * Disallows loopback (127.0.0.1, localhost), link-local (169.254.x.x), and private RFC1918 networks
 */
export function isSafePublicUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Disallow localhost and common local test names
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      return false;
    }

    // Check IP patterns
    // 127.0.0.0/8
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
    // 10.0.0.0/8
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
    // 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
    // 192.168.0.0/16
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
    // 169.254.0.0/16 (AWS/Cloud metadata)
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
    // 0.0.0.0
    if (hostname === '0.0.0.0') return false;

    // IPv6 loopback
    if (hostname === '::1' || hostname === '[::1]') return false;

    return true;
  } catch {
    return false;
  }
}
