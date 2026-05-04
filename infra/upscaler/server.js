// Tiny HTTP wrapper around realcugan-ncnn-vulkan. CPU-only.
// POST /upscale with raw image bytes -> 200 image/png
// GET  /health -> 200 ok

'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.PORT || '8001', 10);
const BIN = process.env.REALCUGAN_BIN || '/app/realcugan-ncnn-vulkan';
const MODELS = process.env.REALCUGAN_MODELS || '/app/models-se';
// Real-CUGAN models-se for 4x ships only the "conservative" variant
// (up4x-conservative.bin) — no separate denoise levels. The CLI maps that
// to -n -1. The conservative model still suppresses JPEG artifacts as part
// of its training; it just preserves more original detail than the
// denoise-heavy variants would.
const SCALE = process.env.REALCUGAN_SCALE || '4';
const NOISE = process.env.REALCUGAN_NOISE || '-1';
const TILE = process.env.REALCUGAN_TILE || '256';
const MAX_BODY = parseInt(process.env.MAX_BODY_BYTES || '5242880', 10); // 5 MB
const REQ_TIMEOUT_MS = parseInt(process.env.REQ_TIMEOUT_MS || '60000', 10);

// Serialize work — CPU-bound; concurrency just thrashes L3 cache.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'GET' && req.url === '/health') {
    return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  }
  if (req.method !== 'POST' || req.url !== '/upscale') {
    return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }

  let aborted = false;
  req.on('aborted', () => {
    aborted = true;
  });

  const chunks = [];
  let total = 0;
  try {
    for await (const c of req) {
      total += c.length;
      if (total > MAX_BODY) {
        return res.writeHead(413, { 'content-type': 'text/plain' }).end('body too large');
      }
      chunks.push(c);
    }
  } catch (e) {
    return res.writeHead(400, { 'content-type': 'text/plain' }).end(`bad body: ${e}`);
  }
  if (aborted) return;
  const body = Buffer.concat(chunks);
  if (body.length === 0) {
    return res.writeHead(400, { 'content-type': 'text/plain' }).end('empty body');
  }

  const reqId = crypto.randomBytes(4).toString('hex');
  const start = Date.now();
  try {
    const png = await serial(() => runUpscale(body, reqId));
    if (aborted) return;
    log('info', reqId, 'ok', { ms: Date.now() - start, in_bytes: body.length, out_bytes: png.length });
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length }).end(png);
  } catch (e) {
    log('error', reqId, 'fail', { ms: Date.now() - start, err: String(e) });
    if (aborted) return;
    res.writeHead(500, { 'content-type': 'application/json' }).end(
      JSON.stringify({ error: String(e) }),
    );
  }
});

server.requestTimeout = REQ_TIMEOUT_MS;
server.headersTimeout = REQ_TIMEOUT_MS + 5000;

server.listen(PORT, () => {
  log('info', '-', 'ready', { port: PORT, bin: BIN, scale: SCALE, noise: NOISE, tile: TILE });
});

async function runUpscale(input, reqId) {
  const id = `${reqId}-${Date.now()}`;
  const inPath = path.join(os.tmpdir(), `omb-${id}.in`);
  const outPath = path.join(os.tmpdir(), `omb-${id}.out.png`);
  await fsp.writeFile(inPath, input);
  try {
    const args = [
      '-g', '-1',
      '-t', TILE,
      '-s', SCALE,
      '-n', NOISE,
      '-m', MODELS,
      '-i', inPath,
      '-o', outPath,
    ];
    log('info', reqId, 'spawn', { args: args.join(' ') });
    const code = await new Promise((resolve, reject) => {
      const proc = spawn(BIN, args, { stdio: ['ignore', 'inherit', 'inherit'] });
      proc.on('error', reject);
      proc.on('exit', resolve);
    });
    if (code !== 0) throw new Error(`realcugan exited ${code}`);
    return await fsp.readFile(outPath);
  } finally {
    await Promise.all([
      fsp.unlink(inPath).catch(() => {}),
      fsp.unlink(outPath).catch(() => {}),
    ]);
  }
}

function log(level, reqId, msg, fields) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    component: 'upscaler',
    req: reqId,
    msg,
    ...fields,
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}
