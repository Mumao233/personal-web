// Classic worker + dynamic ESM import allows the upstream WASM loader's importScripts.
// No frames or landmarks leave this worker/browser. Only local static assets are fetched.
let landmarker;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const { FilesetResolver, HandLandmarker } = await import('./vendor/gesture/package/vision_bundle.mjs');
      const files = await FilesetResolver.forVisionTasks(new URL('./vendor/gesture/package/wasm/', self.location).href.replace(/\/$/, ''));
      landmarker = await HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: new URL('./vendor/gesture/hand_landmarker.task', self.location).href, delegate: 'CPU' },
        runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: .65,
        minHandPresenceConfidence: .65, minTrackingConfidence: .65,
      });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame') {
      try {
        const result = landmarker.detectForVideo(data.bitmap, data.timestamp);
        self.postMessage({ type: 'result', landmarks: result.landmarks });
      } finally { data.bitmap.close(); }
    }
  } catch (error) { self.postMessage({ type: 'error', message: String(error?.message || error) }); }
};
