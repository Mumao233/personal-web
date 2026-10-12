# 太阳系摄像头手势控制

右下角的「手势控制」可展开操作面板。每次打开页面默认关闭；只有用户手动打开「摄像头手势」才会请求权限和加载模型。离开页面、切到后台、按 Esc 或关闭开关时，所有摄像头轨道和识别 Worker 都立即停止。再次进入页面需要重新手动开启。

## 操作

| 模式 | 动作 |
| --- | --- |
| 旋转（默认） | 单手拇指与食指捏合，移动手部旋转视角；松开停下。 |
| 平移 | 点选「平移」，单手捏合后移动手部平移画面。 |
| 选择 | 点选「选择」，食指位置对应屏幕光点；对准星体或轨道标记，捏合并稳定保持约 0.7 秒确认。松开后才能再次选择。 |
| 缩放（所有模式） | 双手同时捏合，拉开两手放大，靠拢缩小；松开停下。 |

镜头预览和屏幕光点按镜像对应。识别丢失立即释放动作；捏合有滞回阈值、运动平滑、小幅抖动死区和突跳重定位。选择需要稳定停留且一次捏合只选一次，不会触发工具栏、链接或表单。鼠标、触屏和原有太阳系功能始终可用。

## 开源库选择

采用 Google **MediaPipe Tasks Vision / Hand Landmarker 0.10.32**，许可 **Apache-2.0**。它直接输出每只手的 21 个三维关键点、支持双手和视频跟踪，适合在现有 Three.js 场景旁独立运行。TensorFlow.js 的 `hand-pose-detection` 也是可用开源选择，但此场景无需再引入 TF.js 后端和适配层。

运行时、WASM、固定版本的模型与许可证均已保存在 `atlas/solar/vendor/gesture/`；来源、哈希、官方 API 文档和模型卡见该目录的 `PROVENANCE.md`。官方模型卡第 2 页标注 Apache License 2.0。修改部署包时需要保留许可证。

官方资料：

- [Hand Landmarker Web API](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js)
- [MediaPipe 开源仓库](https://github.com/google-ai-edge/mediapipe)
- [固定版本 npm 元数据](https://registry.npmjs.org/@mediapipe/tasks-vision/0.10.32)
- [官方模型说明](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/index)
- [TensorFlow.js 手势关键点检测替代实现](https://github.com/tensorflow/tfjs-models/tree/master/hand-pose-detection)

## 数据与性能

摄像头使用 `audio: false`。视频帧只从本地 `<video>` 转为 `ImageBitmap`，通过可转移对象交给本机 Worker；推理后马上释放。没有录像、快照保存、帧上传或服务端识别。识别最大 24 FPS，CPU 推理置于独立 Worker，主线程负责场景；同一时刻最多处理一帧。OFF 时既无摄像头调用，也无模型、WASM 或 Worker 网络请求。

推荐最新版 Chrome / Edge，HTTPS 或 localhost。当前实现需要 Worker、OffscreenCanvas 和 createImageBitmap；不支持的浏览器会给出提示。首次开启需从同站点加载约 19 MB 的模型与一种 WASM 变体，之后由浏览器正常缓存。系统或浏览器权限拒绝、无设备、设备被占用、模型初始化失败、推理异常、摄像头断连均会显示状态并释放资源。

## 集成边界

- `gesture-engine.js`：独立手势解释器和摄像头生命周期。
- `gesture-worker.js`：本地模型加载与视频关键点推理。
- `gesture-control.js/css`：默认关闭的开关、预览、模式说明和光点。
- `solar.js` 的 camera / picking effects 监听 `atlas-gesture` 和 `atlas-gesture-select`；直接操作真实场景与选中逻辑，不合成鼠标点击。清理时解除监听。
- 不使用 localStorage 保存开启状态，不自动请求用户权限。

## 验证

`node --test tests/gesture-control.test.js` 检查合成关键点、防误选和生命周期，包括“关闭后才收到摄像头授权”的竞态。`node tests/gesture-browser-check.mjs` 连接本机整合站点（默认 `http://127.0.0.1:5193`，可用 `TEST_BASE_URL` 改写），用独立无头 Edge 和合成画布视频验证实际 Worker/WASM/模型、开关、拒权和真实场景控制。脚本不会申请物理摄像头。

真实摄像头下的不同光照、肤色、背景和手部动作体验，需要本人打开开关试用确认；自动测试不能替代这一项。
