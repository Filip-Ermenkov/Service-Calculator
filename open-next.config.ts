/**
 * OpenNext build configuration — exists for ONE reason: to install the right
 * sharp binary for the image optimizer's CPU architecture.
 *
 * ── The bug ───────────────────────────────────────────────────────────────────
 * OpenNext installs sharp into the image-optimization bundle with
 * (dist/build/installDeps.js):
 *
 *   npm install --os=linux --arch=arm64 --target=18 --libc=glibc sharp@0.35.4
 *
 * but `--arch` is NOT how npm selects sharp 0.33+'s platform-specific optional
 * dependencies (`@img/sharp-linux-*`) — that is `--cpu`. `--arch` was correct
 * for sharp 0.32.6, which OpenNext 3.x pinned and which resolved its binary
 * through `prebuild-install` (it reads `npm_config_arch`). OpenNext 4 moved to
 * sharp 0.35.4 without changing the flag, so `--os=linux` is honoured while the
 * CPU silently falls back to the BUILD HOST's — x64 on a GitHub runner.
 *
 * Verified by running both commands (2026-10-03):
 *   --arch=arm64 → node_modules/@img/sharp-linux-x64     ← what we deployed
 *   --cpu=arm64  → node_modules/@img/sharp-linux-arm64    ← what we need
 * and by unzipping the deployed Lambda, which contained
 * `@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.4.node` while the function's
 * architecture is arm64 (sst.config.ts leaves SST's arm64 default in place).
 *
 * ── Why it was invisible ──────────────────────────────────────────────────────
 * `require('sharp')` throws on the wrong architecture, and Next CATCHES it:
 * `imageOptimizer`'s try/catch returns `{ buffer: upstreamBuffer, contentType:
 * upstreamType, maxAge: minimumCacheTTL }` — "if we fail to optimize, fallback
 * to the original image". So every request returned HTTP 200 with a perfectly
 * valid, completely unoptimized image: no resize, no WebP, full original bytes.
 * Nothing logs. The only tell is `Cache-Control: max-age=14400` (the
 * `minimumCacheTTL` default) instead of the upstream-derived value, and that the
 * response is byte-identical to the source.
 *
 * `scripts/smoke-image-optimizer.mjs` now fails on exactly this.
 *
 * ── Why `additionalArgs` and not `arch` ───────────────────────────────────────
 * `arch` is kept (harmless, and correct again if OpenNext ever switches the flag
 * or pins a sharp that reads it); `additionalArgs` appends `--cpu=arm64`, which
 * is the value npm actually uses. Supplying `install` REPLACES OpenNext's
 * defaults wholesale (`config.imageOptimization?.install ?? {…}`), so every
 * field it would have set is restated here deliberately — dropping one would
 * silently change the installed package rather than error.
 *
 * KEEP `packages` IN STEP with the sharp version OpenNext defaults to for the
 * pinned `openNextVersion` in sst.config.ts (4.1.5 → sharp 0.35.4), and keep
 * `--cpu` in step with the optimizer Lambda's architecture.
 */
const config = {
  // Required by OpenNextConfig. Empty = keep every default for the server
  // function; this file must not change anything but the sharp install.
  default: {},
  imageOptimization: {
    install: {
      packages: ['sharp@0.35.4'],
      os: 'linux',
      arch: 'arm64' as const,
      libc: 'glibc' as const,
      nodeVersion: '18',
      // The flag that actually works. See the header.
      additionalArgs: '--cpu=arm64',
    },
  },
}

export default config
