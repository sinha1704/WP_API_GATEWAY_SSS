/**
 * Automated 5-Minute Keep-Alive Ping Service
 * Keeps Render free container awake 24/7 with zero downtime and $0 cost.
 *
 * Usage:
 *   node scripts/keep-alive.js https://your-app.onrender.com
 * Or run via cron-job.org / UptimeRobot / GitHub Actions
 */

import http from 'http';
import https from 'https';

const targetUrl = process.argv[2] || process.env.PING_URL || 'http://localhost:3000/health';
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

console.log(`[Keep-Alive] Initializing 5-minute keep-alive ping for: ${targetUrl}`);

function ping() {
  const isHttps = targetUrl.startsWith('https');
  const client = isHttps ? https : http;

  const req = client.get(targetUrl, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      const now = new Date().toLocaleTimeString();
      console.log(`[${now}] Ping success to ${targetUrl} (Status: ${res.statusCode})`);
    });
  });

  req.on('error', (err) => {
    console.error(`[Keep-Alive Error] Failed to ping ${targetUrl}:`, err.message);
  });

  req.setTimeout(10000, () => {
    req.abort();
    console.warn(`[Keep-Alive Warning] Ping to ${targetUrl} timed out.`);
  });
}

// Initial ping
ping();

// Run every 5 minutes
setInterval(ping, INTERVAL_MS);
