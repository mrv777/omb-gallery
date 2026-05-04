# Waifu2x upscaling sidecar. Downloads nihui's waifu2x-ncnn-vulkan static
# binary at build time and exposes it over a tiny HTTP wrapper. Real work
# runs on CPU (`-g -1`); the Vulkan ICD is needed only so the binary's
# startup vkCreateInstance() doesn't abort on a headless box.
#
# Why waifu2x and not realcugan: realcugan-ncnn-vulkan's `-g -1` mode is
# silently broken on headless Linux (binary exits 0 without producing
# output). waifu2x-ncnn-vulkan by the same author uses the same ncnn
# substrate and similar anime-tuned models, but its CPU mode works.
#
# nihui's binaries are amd64-only; pin the image platform so it runs
# correctly on Apple Silicon dev machines (under emulation) and on amd64
# servers natively.
FROM --platform=linux/amd64 node:24-slim

# - libgomp1 is required by ncnn's OpenMP threading on CPU.
# - libvulkan1 + mesa-vulkan-drivers provide a software Vulkan ICD
#   (Mesa lavapipe). The binary always calls vkCreateInstance() at startup
#   for capability detection — without an ICD it aborts with
#   `vkCreateInstance failed -9`. With lavapipe present, the call succeeds
#   and `-g -1` then routes actual inference to ncnn's CPU SIMD path.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl unzip ca-certificates libgomp1 libvulkan1 mesa-vulkan-drivers \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG WAIFU2X_RELEASE=20220728
ARG WAIFU2X_URL=https://github.com/nihui/waifu2x-ncnn-vulkan/releases/download/${WAIFU2X_RELEASE}/waifu2x-ncnn-vulkan-${WAIFU2X_RELEASE}-ubuntu.zip

RUN curl -fsSL -o /tmp/waifu2x.zip "${WAIFU2X_URL}" \
    && unzip /tmp/waifu2x.zip -d /tmp/waifu2x \
    && mv /tmp/waifu2x/waifu2x-ncnn-vulkan-${WAIFU2X_RELEASE}-ubuntu/* /app/ \
    && chmod +x /app/waifu2x-ncnn-vulkan \
    && rm -rf /tmp/waifu2x /tmp/waifu2x.zip

COPY server.js /app/server.js

ENV PORT=8001
EXPOSE 8001

# Drop privileges. The 'node' user is provided by node:24-slim.
USER node

CMD ["node", "/app/server.js"]
