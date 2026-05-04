# Real-CUGAN upscaling sidecar. Downloads nihui's static binary at build
# time and exposes it over a tiny HTTP wrapper. CPU-only — no Vulkan/GPU
# required (binary uses ncnn's SIMD path when -g -1 is passed).
# nihui's realcugan-ncnn-vulkan releases are amd64 binaries only; pin the
# image platform so it runs correctly on Apple Silicon dev machines (under
# emulation) and on amd64 prod servers natively.
FROM --platform=linux/amd64 node:24-slim

# libgomp1 is required by ncnn's OpenMP threading on CPU.
# libvulkan1 is loaded lazily; the binary won't start without it even in CPU mode.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl unzip ca-certificates libgomp1 libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG REALCUGAN_RELEASE=20220728
ARG REALCUGAN_URL=https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/${REALCUGAN_RELEASE}/realcugan-ncnn-vulkan-${REALCUGAN_RELEASE}-ubuntu.zip

RUN curl -fsSL -o /tmp/realcugan.zip "${REALCUGAN_URL}" \
    && unzip /tmp/realcugan.zip -d /tmp/realcugan \
    && mv /tmp/realcugan/realcugan-ncnn-vulkan-${REALCUGAN_RELEASE}-ubuntu/* /app/ \
    && chmod +x /app/realcugan-ncnn-vulkan \
    && rm -rf /tmp/realcugan /tmp/realcugan.zip

COPY server.js /app/server.js

ENV PORT=8001
EXPOSE 8001

# Drop privileges. The 'node' user is provided by node:24-slim.
USER node

CMD ["node", "/app/server.js"]
