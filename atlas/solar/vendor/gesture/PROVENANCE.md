# Hand tracking assets

Retrieved 2026-10-13 from the official npm registry / Google MediaPipe storage.

## Runtime

- Package: `@mediapipe/tasks-vision`, pinned version `0.10.32`.
- npm metadata: https://registry.npmjs.org/@mediapipe/tasks-vision/0.10.32
- Original archive: https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.32.tgz
- Archive SHA-256: `b362a2b56aafcce7857047c25dc8fd69612fd8e75018e264717d24290e7815c1`.
- Extracted unmodified: `vision_bundle.mjs`, `wasm/*`, `package.json`, `README.md`.
- License: Apache-2.0, as declared by upstream `package/package.json`; full license retained in `LICENSE`.
- License source: https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE
- Official API guide: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js
- Upstream repository: https://github.com/google-ai-edge/mediapipe

## Model

- Official Hand Landmarker, float16, version **1**, pinned URL (not `latest`):
  https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
- Size: 7,819,105 bytes.
- SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.
- Official task overview, which links both this model family and its model card:
  https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/index
- Model card: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf
- Model card preserved as `hand-tracking-model-card.pdf`; its page 2 states “LICENSED UNDER Apache License, Version 2.0”.
- Model-card SHA-256: `43127ff8a92e22717f0d8c30dab3efef4641a29cbf50b15ae3de001be94ab76b`.

## Extracted-file SHA-256

| File | SHA-256 |
| --- | --- |
| `package/vision_bundle.mjs` | `de83c48ff329717a27aeb528d5ef5f47f077c628a5302dc483aca5b513e7464b` |
| `package/wasm/vision_wasm_internal.js` | `6f6b86509cf9e163ea1cfec7edc8cf53732699c04781e4c21c557c1ba402310e` |
| `package/wasm/vision_wasm_internal.wasm` | `cb3ec20026a9aecc2a81a93c25630ceb5389297ddb7a5f0bd61dd09cde606b9b` |
| `package/wasm/vision_wasm_nosimd_internal.js` | `9f8fc960e363f0fb2f42f7937b97ae9cf9a5630490f71031fa90caa9bb121938` |
| `package/wasm/vision_wasm_nosimd_internal.wasm` | `924274fcd5ac8985f6570a8573e7971b7bd2d580ba1b8f3beb0ba8f95db6347c` |

All runtime resources are served locally. On first explicit activation the browser loads one matching WASM variant (~10–11 MB), the small JS loader and the ~7.8 MB model. None is requested while the feature remains OFF. No CDN, external model request, telemetry, frame upload, or credential is needed by this integration.
