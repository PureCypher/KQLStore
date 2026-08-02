// ---------------------------------------------------------------------------
// Local development server — the `npm run dev` half that follows `npm run build`.
//
// In the cluster there are two images: nginx serves the built bundle and reverse-proxies
// /api/ to the Express API. Off-cluster there is no nginx and no Service DNS, so this
// stands in for the frontend image. It is a development tool and is never shipped —
// nothing here runs in production, where nginx.conf is the authority.
//
// It deliberately MIRRORS nginx.conf rather than inventing its own behaviour. A dev server
// that is more permissive than production is worse than no dev server: it lets you build
// against behaviour the cluster will not give you, and the difference surfaces after
// deploy. The three places that matters are marked below.
//
// Node built-ins only. The repo takes the same line on its own tooling that it takes on
// the app: a dependency here is a dependency a contributor has to trust.
// ---------------------------------------------------------------------------
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, createReadStream, statSync, mkdirSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');

const PORT = Number(process.env.PORT) || 8080;
const API_PORT = Number(process.env.API_PORT) || 3000;

// data/ is gitignored, as is *.db — a dev database must never become a commit.
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'kqlstore.dev.db');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// MIRROR 1 — the served file set.
//
// The Dockerfile flattens three files into one directory: index.html from the repo root,
// plus app.js and app.css from dist/. Resolving anything else would serve files the image
// does not contain, so a request that works here would 404 in the cluster.
function resolveAsset(pathname) {
  const name = pathname === '/' ? '/index.html' : normalize(pathname);
  if (name.includes('..')) return null;
  if (name === '/index.html') return join(ROOT, 'index.html');
  const candidate = join(DIST, name);
  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
}

// MIRROR 2 — the Content-Security-Policy and security headers, copied from nginx.conf.
//
// Serving without them locally is how a CSP violation reaches the cluster undetected: the
// app works on your machine and the browser blocks it in production. If you change these,
// change nginx.conf in the same commit — it is the one that actually protects users.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
    + "base-uri 'none'; form-action 'none'; object-src 'none'",
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Forward a request to the API, preserving method, headers and body. */
function proxyToApi(req, res) {
  const upstream = httpRequest(
    {
      hostname: '127.0.0.1',
      port: API_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` },
    },
    (apiRes) => {
      res.writeHead(apiRes.statusCode, apiRes.headers);
      apiRes.pipe(res);
    },
  );
  // A 502 with the reason beats a hung request. The usual cause is the API having exited,
  // which is visible in this terminal because its output is piped through below.
  upstream.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `API unreachable on port ${API_PORT}: ${err.message}` }));
  });
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;

  if (pathname.startsWith('/api/')) {
    proxyToApi(req, res);
    return;
  }

  const file = resolveAsset(pathname);

  // MIRROR 3 — a missing asset is a 404, not index.html.
  //
  // nginx.conf makes this point explicitly: this is a single-page app with NO client-side
  // router, so an index.html fallback turns every typo and every failed asset fetch into a
  // 200 carrying an HTML document. That failure is silent and confusing; a 404 is not.
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    // The bundle filenames are not content-hashed, so they must be revalidated rather than
    // cached immutably — same reasoning, and same value, as nginx.conf.
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  createReadStream(file).pipe(res);
});

/**
 * Start the API alongside the static server.
 *
 * Without it the SPA loads and immediately shows its API-unreachable error, which makes
 * `npm run dev` look broken when it is only incomplete. The API is a separate package with
 * its own dependencies, so a missing api/node_modules is reported as the actionable thing
 * it is rather than as a stack trace.
 */
function startApi() {
  if (!existsSync(join(ROOT, 'api', 'node_modules'))) {
    console.error('\n  api/node_modules is missing — serving the bundle only.');
    console.error('  Run `npm --prefix api ci` to install it, then restart.\n');
    return null;
  }

  mkdirSync(dirname(DB_PATH), { recursive: true });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: join(ROOT, 'api'),
    env: { ...process.env, PORT: String(API_PORT), DB_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const relay = (stream, sink) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) sink(`  [api] ${line}`);
      }
    });
  };
  relay(child.stdout, (l) => console.log(l));
  relay(child.stderr, (l) => console.error(l));

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`  [api] exited with code ${code}`);
  });
  return child;
}

const api = startApi();

// Leaving the API running after this process dies orphans a writer on the dev database,
// and the next `npm run dev` then fails to bind the port for reasons that look unrelated.
const shutdown = () => {
  if (api) api.kill('SIGTERM');
  server.close(() => process.exit(0));
  // Do not wait indefinitely on a hung connection during a Ctrl-C.
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  KQL Store dev server`);
  console.log(`  app   http://127.0.0.1:${PORT}`);
  console.log(`  api   http://127.0.0.1:${API_PORT}  (proxied at /api/)`);
  console.log(`  db    ${DB_PATH}`);
  console.log(`\n  Rebuild after editing src/: npm run build\n`);
});
