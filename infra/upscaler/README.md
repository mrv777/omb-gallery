# Real-CUGAN upscaler sidecar

CPU-only neural upscaler. Wraps [`realcugan-ncnn-vulkan`](https://github.com/nihui/realcugan-ncnn-vulkan) (MIT) in a tiny Node HTTP server. No GPU required.

## What it does

`POST /upscale` with a raw JPEG/WebP/PNG body → returns a 4× upscaled PNG. Internally calls the `realcugan-ncnn-vulkan` binary in CPU mode (`-g -1`) with `-s 4 -n -1` (4× scale, conservative model — the only variant shipped for 4× in models-se; still suppresses JPEG artifacts via training).

Single binary, models-se variant (squeeze-excite, balanced quality vs speed). No Python, no PyTorch, ~600 MB RSS at peak.

`GET /health` → `200 ok`

The binary is amd64-only, so the Dockerfile pins `--platform=linux/amd64`. It runs natively on amd64 hosts and under emulation on Apple Silicon dev machines.

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
| `REALCUGAN_SCALE` | `4` | Output scale (2/3/4) |
| `REALCUGAN_NOISE` | `-1` | Denoising strength (-1/0/1/2/3). For `-s 4`, models-se only ships the conservative variant (-1). For `-s 2`, all values are valid. |
| `REALCUGAN_TILE` | `256` | Tile size; lower = less RAM, slower |
| `MAX_BODY_BYTES` | `5242880` | 5 MB request cap |
| `REQ_TIMEOUT_MS` | `60000` | Per-request socket timeout |

## Latency expectations

For the OMB use case (336 px JPEG → 1344 px PNG):

- Modern Xeon-class CPU, native amd64 → **~1.5–4 s** per request
- Apple Silicon under amd64 emulation → ~8 s per request

Concurrency is intentionally serialized inside the wrapper — multiple in-flight requests just thrash L3 cache; running them sequentially is faster end-to-end. The Next.js app's `/api/upscale` route also rate-limits (10/min per IP, 100/10min global) before sending work here, so steady-state load is bounded.

## Production deployment

Run it as a long-lived `docker run` with `--restart unless-stopped` — same lifecycle as a systemd-managed binary, simpler to manage than threading a second app through Coolify. SSH-based deployment runbook is in the operator's local `DEPLOYMENT.md`. The shape:

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
  --cpus 4 \
  omb-upscaler
```

Bind to `0.0.0.0:8001` so the app container can reach it via `host.docker.internal` (same mechanism the app uses for `ord` on 4000). Verify your firewall blocks 8001 externally — for ufw:

```bash
sudo ufw status verbose | grep -E "8001|default"
sudo ufw deny 8001  # if not already covered by a default-deny policy
```

### Wire the Next.js app to it

Set `UPSCALER_URL=http://host.docker.internal:8001/upscale` in the app's environment and redeploy. Sanity check from inside the app container:

```bash
docker exec -it <app-container> curl -fsS http://host.docker.internal:8001/health
# -> ok
```

### Updating later

```bash
cd <wherever you cloned>/infra/upscaler
git pull
docker build -t omb-upscaler .
docker stop omb-upscaler && docker rm omb-upscaler
docker run -d --name omb-upscaler --restart unless-stopped \
  -p 0.0.0.0:8001:8001 --memory 1g --cpus 4 omb-upscaler
```

The app caches generated PNGs by inscription id, so the cache survives upscaler restarts — only fresh inscriptions pay the regen cost.

### Logs

```bash
docker logs -f omb-upscaler           # tail
docker logs --tail 200 omb-upscaler   # last N lines
```

Output is structured JSON (one event per line) with `t`, `level`, `component`, `req`, `msg` fields — same shape as the Next.js app's `src/lib/log.ts`.

### If quality is good but CPU latency hurts

The Dockerfile is GPU-ready. Drop `-g -1` from `server.js`'s `args` array and add `--gpus all` to the `docker run`. NVIDIA needs `nvidia-container-toolkit` installed on the host; AMD works out of the box on a Vulkan-capable kernel.
