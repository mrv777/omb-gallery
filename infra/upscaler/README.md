# Waifu2x upscaler sidecar

CPU-only neural upscaler. Wraps [`waifu2x-ncnn-vulkan`](https://github.com/nihui/waifu2x-ncnn-vulkan) (MIT) in a tiny Node HTTP server. No GPU required.

## What it does

`POST /upscale` with a raw JPEG/WebP/PNG body → returns a 4× upscaled PNG. Internally calls `waifu2x-ncnn-vulkan` in CPU mode (`-g -1`) with `-s 4 -n 2` against the `models-cunet` weights — anime/illustration tuned, with moderate denoising for JPEG cleanup.

`GET /health` → `200 ok`

The binary is amd64-only, so the Dockerfile pins `--platform=linux/amd64`. Runs natively on amd64 hosts and under emulation on Apple Silicon dev machines.

### Why waifu2x and not Real-CUGAN

We initially tried `realcugan-ncnn-vulkan` (also by nihui, slightly faster on GPU). Its `-g -1` CPU mode is silently broken on headless Linux — the binary exits 0 without producing any output. Locally on Apple Silicon it appeared to work because OrbStack provides MoltenVK as a real GPU backend, so it was actually using the GPU. Switched to `waifu2x-ncnn-vulkan` whose CPU path is genuinely supported.

## Local dev

```bash
# Build
docker build --platform linux/amd64 -t omb-upscaler infra/upscaler/

# Run
docker run --rm -d --platform linux/amd64 -p 8001:8001 --name omb-upscaler omb-upscaler

# Smoke test
curl -fsS http://localhost:8001/health
curl -fsS --data-binary @public/images/red/103092.jpg \
     -H "content-type: application/octet-stream" \
     http://localhost:8001/upscale > /tmp/upscaled.png
file /tmp/upscaled.png  # should report 1344x1344 PNG

# Stop
docker stop omb-upscaler
```

The Next.js app's `/api/upscale?id=<num>` proxies here. Default URL is `http://localhost:8001/upscale`; override with the `UPSCALER_URL` env var (required in production).

## Environment

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8001` | HTTP listen port |
| `WAIFU2X_SCALE` | `4` | Output scale (1/2/4/8/16/32). cunet cascades 2× passes internally for non-2 values. |
| `WAIFU2X_NOISE` | `2` | Denoising strength (-1/0/1/2/3). 2 is moderate JPEG cleanup without flattening hand-drawn line wobble. |
| `WAIFU2X_TILE` | `200` | Tile size. **Critical for CPU latency** — at 256 the input fits in a single tile and runs through one big inference pass, ~6× slower than smaller tiles. 200 is a measured sweet spot for 336px source. |
| `WAIFU2X_MODELS` | `/app/models-cunet` | Model directory inside the image. Other options: `/app/models-upconv_7_anime_style_art_rgb`, `/app/models-upconv_7_photo`. cunet is highest quality for line art; upconv variants are alternatives if needed. |
| `MAX_BODY_BYTES` | `5242880` | 5 MB request cap |
| `REQ_TIMEOUT_MS` | `60000` | Per-request socket timeout |

## Latency expectations (measured)

For the OMB use case (336 px JPEG → 1344 px PNG, models-cunet, `-s 4 -n 2 -t 200`):

- Xeon E-2274G class CPU, 8 threads, no GPU → **~9 s** per request
- Apple Silicon under amd64 emulation → ~8 s per request (lucky — MoltenVK fast-path)

Concurrency is intentionally serialized inside the wrapper — multiple in-flight requests thrash L3 cache and are slower end-to-end than running sequentially. The Next.js app's `/api/upscale` route also rate-limits cache misses (10/min per IP, 100/10min global) before sending work here, so steady-state load is bounded.

## Production deployment

Run it as a long-lived `docker run` with `--restart unless-stopped` — same lifecycle as a systemd-managed binary, simpler than threading a second app through Coolify. The full SSH-based runbook is in the operator's local `DEPLOYMENT.md`. The shape:

```bash
# On the host:
git clone --depth 1 <repo-url> source
cd source/infra/upscaler
docker build -t omb-upscaler .
docker run -d \
  --name omb-upscaler \
  --restart unless-stopped \
  -p 0.0.0.0:8001:8001 \
  --memory 1g \
  omb-upscaler
```

**Don't pass `--cpus N`** — limiting CPUs hurts perf badly (waifu2x scales with thread count). Let it use all host cores; CPU-bound serialization is handled inside the wrapper.

Bind to `0.0.0.0:8001` so containers on a Docker bridge network can reach it via the bridge gateway. Lock down externally with the host firewall — for ufw with a Coolify-managed app, allow only the Coolify subnet:

```bash
sudo ufw allow from 10.0.1.0/24 to any port 8001 proto tcp comment "upscaler for coolify containers"
sudo ufw status verbose | grep 8001
```

### Wire the Next.js app to it

The app reaches host services via the Coolify bridge gateway IP, not `host.docker.internal` (which doesn't resolve from inside containers on the `coolify` network). Set the env var:

```
UPSCALER_URL=http://10.0.1.1:8001/upscale
```

Redeploy. Sanity check from inside the app container:

```bash
docker exec -it <app-container> curl -fsS http://10.0.1.1:8001/health
# -> ok
```

### Updating later

```bash
cd <wherever you cloned>/source
git pull
cd infra/upscaler
docker build -t omb-upscaler .
docker stop omb-upscaler && docker rm omb-upscaler
docker run -d --name omb-upscaler --restart unless-stopped \
  -p 0.0.0.0:8001:8001 --memory 1g omb-upscaler
```

The app caches generated PNGs by inscription id at `/data/upscaled/`, so the cache survives upscaler restarts — only fresh inscriptions pay the regen cost.

### Logs

```bash
docker logs -f omb-upscaler           # tail
docker logs --tail 200 omb-upscaler   # last N lines
```

Output is structured JSON (one event per line) with `t`, `level`, `component`, `req`, `msg` fields — same shape as the Next.js app's `src/lib/log.ts`.

### If CPU latency hurts

The Dockerfile is GPU-ready. Drop `-g -1` from `server.js`'s `args` array and add `--gpus all` to the `docker run`. NVIDIA needs `nvidia-container-toolkit` on the host; AMD works on a Vulkan-capable kernel.

Alternatively, pre-warm the cache by hitting `/api/upscale?id=<n>` for every inscription number in the collection over a few hours — total CPU is bounded by collection size × per-image latency, and after that every user click is an instant cache hit.
