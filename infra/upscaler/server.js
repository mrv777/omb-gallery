// Tiny HTTP wrapper around waifu2x-ncnn-vulkan, run in CPU mode.
// POST /upscale with raw image bytes -> 200 image/png
// GET  /health -> 200 ok
//
// Note: an earlier version used realcugan-ncnn-vulkan, but its `-g -1`
// CPU mode silently no-ops on headless Linux (exits 0 without producing
// output). waifu2x-ncnn-vulkan by the same author uses the same ncnn
// substrate and similarly anime-tuned models, but its CPU mode actually
// works.

'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.PORT || '8001', 10);
const BIN = process.env.WAIFU2X_BIN || '/app/waifu2x-ncnn-vulkan';
// models-cunet: anime/illustration tuned, supports denoise 0-3 at all
// scales by cascading 2x passes. Best fit for hand-drawn ink art with
// JPEG noise to clean up.
const MODELS = process.env.WAIFU2X_MODELS || '/app/models-cunet';
const SCALE = process.env.WAIFU2X_SCALE || '4';
// Noise 0-3 (or -1 to skip denoising). 2 = moderate JPEG cleanup
// without over-smoothing the hand-drawn line wobble.
const NOISE = process.env.WAIFU2X_NOISE || '2';
// Tile size matters a LOT for CPU latency. With `-t 256` the input fits
// in a single tile and the whole image runs through one big inference
// pass — empirically ~6x slower than smaller tiles that let ncnn
// pipeline through multiple smaller passes. 200 is a measured sweet spot
// for our 336px source on Xeon E-2274G; finer tiles below 100 didn't
// improve further.
const TILE = process.env.WAIFU2X_TILE || '200';
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
    log('info', reqId, 'ok', {
      ms: Date.now() - start,
      in_bytes: body.length,
      out_bytes: png.length,
    });
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length }).end(png);
  } catch (e) {
    log('error', reqId, 'fail', { ms: Date.now() - start, err: String(e) });
    if (aborted) return;
    res
      .writeHead(500, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: String(e) }));
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
    if (code !== 0) throw new Error(`waifu2x exited ${code}`);
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
