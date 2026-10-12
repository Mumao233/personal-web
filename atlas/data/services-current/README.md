# 地转洋流数据与地形服务

## 地转洋流：NOAA / AOML

数据来自 NOAA / AOML 的 **Near Real Time Geostrophic Currents**（`miamicurrents`），是卫星高度计资料派生的地转洋流分析，每日发布并存在发布延迟。它不是当前位置的即时实测，也不包含全部风生流、潮流或波浪，不能作为航海预报。

- 数据说明及授权：<https://cwcgom.aoml.noaa.gov/erddap/info/miamicurrents/index.html>
- 上游字段为 `u_current`、`v_current`，单位分别为向东、向北的米/秒。
- 原始分辨率为 0.2°；客户端请求每 5 个格点取 1 个，得到 1° 网格。显示时转换为 360 × 180 的格点中心网格，**四个相邻源点都有数据时才进行双线性插值**。
- `manifest.json` 保留真实 `validTime`、抓取时间、请求 URL、源响应 SHA256、生成文件 SHA256、有效和缺测格点数量。检查新数据不会把旧资料日期改成当前日期。
- `.oacf` 是原站渲染器支持的 OACF v1 文件，速度按 0.0001 m/s 量化为有符号 16 位整数，`simulated` 为 `false`。超出可表示范围的源值会使更新失败，不截断成虚假速度。
- 原始覆盖范围约为 64.7°S–64.7°N。陆地、极区和其他缺测区域的掩码保持关闭；文件中的零值占位不能当作真实静止洋流。前端不允许用普通海陆掩码覆盖源数据的缺测掩码。

随项目保存的快照由本目录的 `manifest.json` 指向。运行 `python server.py --port 8766` 后，`currents_service.py` 在 `.runtime/currents/` 保存更新。服务优先使用通过长度与 SHA256 校验的最新缓存；浏览器打开网页后自动检查，每 6 小时才向上游请求新产品，强制更新最短间隔为 15 分钟。同一时刻只执行一个更新任务。

关闭「自动更新数据」或离线后，请求使用 `offline=1`，服务只读缓存，不发起上游下载。源服务失败时保留真实缓存并显示更新失败状态；保存日期仍然可见。只有真实文件均不可用的损坏安装才允许原有模拟演示回退，界面必须明确标记为模拟。

接口：

- `GET /__local/currents/status`：只读运行状态。
- `GET /__local/currents/manifest.json`：读取缓存并按间隔检查更新。
- `GET /__local/currents/manifest.json?offline=1`：只读缓存。
- `GET /__local/currents/files/<文件名>.oacf`：读取已保存文件。
- `POST /__local/currents/refresh`：受时间间隔及同源检查限制的更新。

这是固定公开数据源的客户端，不是任意网址代理。每 24 小时重新检查源站 robots.txt；明确禁止时不下载。**HYCOM 数据服务因 robots.txt 禁止未接入，交付项目不包含 HYCOM 测试数据。**

## 三维地形：Mapzen Terrarium

三维山地使用公开 [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) 的 Terrarium 高程 PNG，包含 USGS / SRTM / GMTED / ETOPO1 等高程资料。这是地形模型，不是随时更新的卫星照片。详细署名和各源授权见 `credits/Mapzen-terrain-attribution.md`。

`terrain_service.py` 仅代理固定的 `elevation-tiles-prod.s3.amazonaws.com/terrarium/` 瓦片。原站解码公式为 `(R × 256 + G + B / 256) - 32768` 米，再生成 Cesium 高程网格。服务验证 PNG 尺寸、颜色格式和 CRC，按需保存至 `.runtime/terrain/`，每个瓦片有来源与 SHA256 元数据。最大并发 6 个、最大层级 15、缓存上限 128 MiB，缓存新鲜期 1 年。

离线可重用已浏览地区的瓦片；没有缓存的区域明确回退到椭球面，不填入伪造山地。离线请求缺失瓦片返回空的 HTTP 204。底图仍是已保存的低分辨率影像，近距离画面清晰度与高程模型精度不同。

## 可重复验证

`tools/verify-terrain-current.cjs` 使用 Playwright / Chrome 在本地服务验证：真实 OACF 校验和、浏览器原始渲染 store 中的有效掩码数量、极区缺测、洋流动画、喜马拉雅高程及 PNG 解码、离线缓存、未缓存区域回退、Console / Network 错误。测试使用临时只读探针读取原始模块数据，不修改生产 bundle。

报告：`evidence/terrain-current-browser.json`；截图：`services-geostrophic-currents.png`、`services-himalaya-terrain.png`、`services-terrain-offline-cache.png`、`services-terrain-offline-fallback.png`（均位于 `evidence/`）。测试按实际源日期比较，允许每日产品在两次页面加载间更新。
