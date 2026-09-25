// Custom HTTPS dev server for the Next.js dashboard
// Serves the app on https://localhost:4400 using the shared self-signed certs

const { createServer } = require('https');
const { parse } = require('url');
const next = require('next');
const fs = require('fs');
const path = require('path');

const dev = process.env.NODE_ENV !== 'production';
const PORT = Number(process.env.DASHBOARD_PORT) || 4400;
console.log('[dashboard] Initializing Next.js app...');
const app = next({ dev, port: PORT });
const handle = app.getRequestHandler();

const certDir = path.join(__dirname, '..', 'certs');

console.log('[dashboard] Reading HTTPS certs...');
const httpsOptions = {
  key: fs.readFileSync(path.join(certDir, 'localhost-key.pem')),
  cert: fs.readFileSync(path.join(certDir, 'localhost-cert.pem')),
};

app.prepare().then(() => {
  console.log('[dashboard] app.prepare() complete. Starting HTTPS server...');
  createServer(httpsOptions, (req, res) => {
    console.log('[dashboard] HTTPS server received request:', req.url);
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  }).listen(PORT, (err) => {
    if (err) {
      console.error('[dashboard] HTTPS server error:', err);
      throw err;
    }
    console.log(`> Dashboard ready on https://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('[dashboard] app.prepare() failed:', err);
});
