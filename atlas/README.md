# Solar System Atlas · 离线保存与自动联网数据

原网站：<https://solar-system-atlas.pages.dev/solar/>  
修复日期：2026-10-13。保留原站前端、界面与 3D 场景。界面作者为 **木头做的猫**，作者区域没有个人资料超链接；素材来源与开源库许可保留。

## 启动

**Windows：解压整个目录，双击 `start.bat`。** 需要 Python 3.9 或更新版本，不需要 npm 或 Python 第三方库。浏览已保存内容可以离线；更新气象、洋流和卫星海洋产品需要联网。

启动器打开 <http://127.0.0.1:8766/solar/>。保持终端运行，按 `Ctrl+C` 停止。再次启动会复用同目录服务，不会结束其他程序。

也可在本目录执行：

```powershell
python server.py --open
```

端口冲突时使用 `.\start.bat -Port 8770`，或 `python server.py --port 8770 --open`。

请通过 HTTP 打开，并保留整个目录；直接双击 HTML 的 `file://` 模式不能正确加载 ES 模块、Worker 和数据。

| 地址 | 功能 |
|---|---|
| `/` | 原根入口逻辑，通常进入太阳系 |
| `/solar/` | 开场、太阳系图谱、任务与轨道目录 |
| `/?view=globe&from=solar` | 地球、底图、云层、地理标注 |
| `/?view=map` | 原站的地球洋流分析视图，并非独立二维地图应用 |
| `/?view=depth` | 原站地球深度剖面面板 |

太阳系搜索“地球”，进入档案后点击“探索地球”；地球左上角“← 地球系统”返回。专用服务器支持 `/solar/` 下无扩展名页面刷新、正确 MIME 与音频 Range/HEAD，缺失资源真正返回 404。

标准 `python -m http.server 8766 --bind 127.0.0.1` 也验证可打开四个主要入口；任意 SPA 子路径刷新和完整音频 Range 支持请使用附带的 `server.py`。

## 联网气象预报（2026-10-12 新增）

进入地球后，点击 **图层 → 查询位置气象与海流**，选择位置或输入经纬度。点击 **图层 → 全部图层与来源**，可切换全球风、降水和云量预报，并找到联网开关及更新按钮。

**打开地球页面即自动获取，无须先打开图层或点击刷新。** 前台每分钟检查本地气象服务，由服务按每小时频率获取全球源数据；切回页面、窗口重新聚焦和网络恢复也会自动检查。后台标签页暂停周期检查。选点面板打开后每 5 分钟更新，切回页面或恢复网络时自动恢复查询。事件会合并并限频，手动关闭联网的选择会保留。

| 功能 | 公开数据来源 | 更新与保存 |
|---|---|---|
| 选点风速、风向、降水 | Open-Meteo Weather API | 面板打开且前台可见时，每 5 分钟检查；“查询 / 刷新”可立即查询 |
| 选点海表流速、流向 | Open-Meteo Marine API / Copernicus / Météo-France SMOC | 与天气分别请求、分别缓存；内陆返回空值时明确显示无数据 |
| 全球 10 米风场 | NOAA / NCEP GFS，经 NSF Unidata NCSS | 保留完整 0.25°、1440×721 网格，使用原粒子动画 |
| 全球降水率、云量预报 | 同一 GFS 数据集 | 每小时检查；手动更新最短间隔 5 分钟；后台下载成功后更新原图层 |

全球更新必须使用附带的 `start.bat` / `server.py`，普通静态服务器只能显示全球存档并支持选点联网查询。服务器在本机后台读取公开 NetCDF 数据，检查 robots.txt、维度、单位、时间和数值，再转换为原前端使用的二进制格式；无须注册、密钥或额外软件包。每次全球下载约 16.6 MB；页面的分钟检查仅读取本地元数据，源数据未变化时复用网格。

页面分别显示**数据有效时间**与**取得时间**。这是数值模式预报，不是现场观测：点降水是所示 15 分钟时段的量（mm），全球图层是降水率（mm/h）；风向为来向，海流方向为流向。GFS 模型有发布周期，查询更新不保证每次产生新模式数据。

浏览器为最多 24 个选点保存真实响应。全球数据存在 `.runtime/weather/`，保留当前、上一版以及最近两小时分块，并校验 SHA256；原 `weather/` 离线快照仍保留。断网时使用缓存并保留原时间，无缓存就显示不可用；不会把缺测海流变成零。关闭“自动更新数据”后，选点只读缓存，全球只读本机已有数据。

**范围区别：**“云量预报”会更新；“摄影云层”仍是保存的影像。海流选点数值会更新；全球洋流动画已改为 NOAA/AOML 卫星派生地转洋流分析（有发布延迟，不等同于完整海表流）。卫星轨道仍为此前修复的历史快照回放。

Open-Meteo 数据按 CC BY 4.0 署名；公共免费服务面向非商业使用，官方限额为每分钟 600、每小时 5,000、每日 10,000 次。原资料来源署名保留。上游服务故障、限流或断网会触发缓存回退，程序不绕过访问限制。

本次已实际取得 GFS 2026-10-12 06:00 UTC（北京时间 14:00）的预报，模型运行时间为当日 00:00 UTC。联网后时间会随源更新。验证详见 `evidence/live-weather-validation.json`、`point-forecast-module.json`、`live-global-verification.json` 与三张 `live-global-*.png`。

## 新接入的地球服务（2026-10-12）

**自动更新默认开启，无须手动点击更新按钮。** 当前配置在地球网页打开且前台可见时检查数据；关闭页面或停止本地服务器后暂停，下次打开会恢复检查。

入口：**图层 → 全部图层与来源**。保留原开关、Cesium 场景与动画，通过小型独立模块接入。需要更新的服务跟随“自动更新数据”开关；关闭后只读真实缓存。前台每分钟检查本地元数据，上游海洋产品及地转洋流至多每 6 小时自动检查，页面重新聚焦、网络恢复时会唤醒检查。新产品未发布或取数失败时保留原日期。

| 图层 | 来源与性质 | 随包数据 / 更新方式 |
|---|---|---|
| 海表温度 | NASA GIBS / JPL GHRSST MUR，每日海温分析 | 2026-10-10；全球透明影像及官方 °C 色标 |
| 海表盐度 | NASA GIBS / SMAP CAP，8 日滑动平均 | 2026-10-07；官方 PSU 色标，非单日实时观测 |
| 叶绿素 a | NASA GIBS / Aqua MODIS，日卫星条带 | 2026-10-11；mg/m³，云遮挡及未观测处保持透明 |
| 地转洋流 | NOAA/AOML，卫星派生近实时地转分量 | 2026-10-10 00:00 UTC；原 0.2° 网格采样到 1°，复用原流线动画 |
| 真实三维地形 | Mapzen Terrarium / AWS 公开 DEM | 缩放时加载并缓存；这些是高程基准资料，并非实时变化 |
| 板块边界 | PB2002 / Bird (2003)，ODC-By-1.0 | 241 条真实边界，固定版本离线资料 |
| 俯冲带·洋中脊 | PB2002 原始 OSR / SUB 分类 | 662 条连续线；黄色洋中脊、粉色俯冲带，不是完整海底地貌清单 |
| 专属经济区 | Marine Regions / VLIZ v12（2023），CC BY 4.0 | 官方 4096×2048 透明 WMS 图与图例；保留争议边界线型，仅供参考 |

海温、盐度和叶绿素保存于 `data/ocean/`，更新保存于 `.runtime/ocean/`，使用不可变 SHA256 分代目录及原子指针，保留最近 4 代。地转洋流保存于 `data/services-current/` 及 `.runtime/currents/`；OACF 文件经过 SHA256 校验，缺测与极区保持 mask，不填入模拟值。参考资料保存于 `data/services-reference/`。高程缓存 `.runtime/terrain/` 上限 128 MB；极区或无缓存缺失区域显示椭球，不伪造山地。

三张海洋影像为 1024×512 显示网格，放大后受分辨率限制；图层提供颜色与来源，不从彩色图片反推精确选点数值。普通静态 HTTP 服务可使用随包海洋／地转／参考快照；自动更新和高程代理需要附带的 `server.py`。所有远程入口固定到公开来源，不是任意 URL 代理，不需密钥。

HYCOM 数据服务因 robots.txt 禁止相关自动请求而被排除，探测结果不作为产品数据交付。上游公开服务可能调整接口、限制请求或暂时离线；代码保留缓存和原有效时间，错误不会覆盖有效资料。合法来源和授权链接保留，作者信息仍为木头做的猫。

## 本次修复

- **补回地球模块**：原根入口、动态 Earth 应用、Cesium、递归 Worker 依赖、地理数据、深度图和物种照片。“探索地球”不再跳回太阳系。
- **补齐真实资源**：682 张地表瓦片（0–4 级）、168 张云瓦片（0–2 级）、97 张航天器照片、18 张物种照片、字体、太阳系实际使用的 512/1K/2K/4K 贴图。没有以生成图替代原图。
- **修复卫星过期消失**：从真实存档时刻开始 1× 回放，明确标为“轨道快照回放”。保留七天有效性过滤，不冒充今天的卫星位置。
- **恢复完整音乐**：14 首专辑曲目及 2 首场景彩蛋曲完整保存。旧 Sun Mother 缺失开头 98,304 字节，现为完整 216.36 秒音频。修复暂停切曲、选曲、恢复旧槽位和快速切曲问题，直接播放本地文件。
- **恢复天气快照**：GFS 元数据、完整二进制文件、32 个分块；逐块 SHA256 和拼接校验通过。
- **修复点击及跨页面行为**：指南面板接收点击，关闭按钮不再被画布截走；太阳系与地球往返保留音乐开关。
- **清除伪数据**：真实 `earth-catalog.json` 替换 HTML 壳，伪 `/api/orbits` 移出运行目录。

## 数据与离线范围

| 内容 | 保存的数据 / 行为 |
|---|---|
| 任务档案 | 原站 206 项档案 |
| 轨道元素 | 2026-09-24 13:32:42 UTC 的 16,611 条真实记录；快照起点 16,577 条有效，34 条过期或不可传播 |
| 独立轨道目录 | 原站真实 `data/earth-catalog.json`，15,994 项；与元素快照的日期、统计口径不同 |
| 气象 | 保留 2026-10-03 09:00 UTC 原始快照；联网可更新全球 GFS 图层和 Open-Meteo 选点预报 |
| 地表、云图 | 原站公开静态图片与有限瓦片层级，非实时卫星影像 |
| 洋流 | NOAA/AOML 近实时地转分析；随包真实快照有效时间为 2026-10-10 00:00 UTC，联网按日产品更新 |
| 音频 | 14 首专辑曲目 + 帕劳 / 丹麦场景 2 首原曲；完整文件和实际播放已验证 |

基础场景不依赖外部网络。轨道会随会话时间推进，重新打开从快照时刻开始。气象功能默认启用联网更新，可用面板开关切换离线；失去网络时保留数据的真实原日期。

## 仍有限制的功能和未取得内容

1. **实时轨道 API**：原 `/api/orbits` 在普通 Chrome 中重定向到 `solar-system-atlas-pi.vercel.app/api/orbits`，本次返回 503。离线版直接读取真实存档，不后台重试，不编造数据。
2. **任意坐标最新预报**：已接入 Open-Meteo；联网才能取得新数据。缓存仅覆盖曾查询的坐标，未查询过的位置在离线时无选点预报。
3. **原站洋流文件**：`/current/manifest.json` 返回 HTML 壳；已用 NOAA/AOML 公开地转洋流产品替代。该产品只含地转分量，有延迟和缺测，不含完整风生流、潮汐或波浪。
4. **地图精度**：使用原站本地影像模式，保存至第 4 级。极近距离可能像素放大，不下载在线高精度瓦片。已接入 Mapzen 真实三维高程并按需缓存；未缓存且断网时缺失部分退回椭球面。原始地表影像精度不随高程增加，近距离仍可能模糊。
5. **尚未接入的图层**：季风诊断与夜间气辉仍关闭并说明原因。NOAA CPC 两张标为实时的季风指数图实际最后修改于 2014 年；近年的 850 hPa 风场不能直接等同季风指数。NASA GOLD 有远紫外气辉数据，但覆盖、波段与原全球可见光夜间图层不同；未用极光或装饰动画代替。
6. **源码辅助文件**：检查的主 JS/CSS source map、`manifest.webmanifest`、`sitemap.xml` 均返回 HTML 壳，未保存为假文件。交付为公开构建产物，未取得原 React/TypeScript 源工程。
7. **外部链接**：资料、音乐和素材来源外链需要联网，未抓取无关第三方网站。用户主动在太阳系播放器填写的外部音源 URL 也需要联网。

原专辑清单署名 melodysheep / *The Arrow of Time*，许可为 Attribution Non Commercial Share Alike。其他曲目、影像和库保留各自原来源，见专辑清单和页面资料来源。

## 抓取和技术栈

- Python、Node.js、Playwright 驱动普通安装版 Chrome，实际加载、点击导航、监控 Network 并保存响应。没有改 User-Agent、使用代理或绕过挑战。
- 遵守原 `robots.txt` 的 `User-agent: * / Allow: /`。仅处理同域公开资源及原播放器实际重定向的必要公开音乐，没有绕过登录、付费或权限限制。
- 解析 HTML `src/href`、CSS `url()`、JS 导入及加载器路径、JSON 清单、贴图尺寸变体和有限瓦片坐标；按 URL 去重，校验状态、MIME、魔数和内容，排除 HTML 假成功响应。
- 预构建 React 前端；太阳系使用 Three.js r186 / React Three Fiber 与 SGP4 Worker，地球使用 Cesium 1.132。路由由客户端状态和根查询参数控制。已观察内容由代码和纹理生成，无需额外 GLTF/GLB、HDR 或 WASM。
- 尽量保留目录。修复集中在现有 bundle 的本地数据 / 音频读取、回放时钟、离线提示，以及少量 CSS 点击规则，没有手工重写 UI。

## 最终验证

离线回归测试关闭联网预报，并**拦截非 localhost / 127.0.0.1 请求**；在线预报测试实际请求两个 Open-Meteo API 和本地 GFS 服务，再人为阻断外网验证缓存。新服务最终在线/离线检查没有 HTTP 4xx/5xx、Console error 或页面 JS 异常。故障注入时浏览器按预期记录中断，结果继续显示明确标记的缓存。

| 检查 | 通过项数 | 证据 |
|---|---:|---|
| 太阳系、作者、目录、ISS、搜索、指南、语言、时间线、地球入口、刷新 | 11 | `evidence/repair-solar-validation.json` |
| 地球底图、缩放、风场、照片、北京搜索、潜点、深度、动画、返回 | 9/10，详见下述网络限制 | `evidence/repair-earth-validation.json` |
| 音乐播放、切曲、暂停恢复、进度、快速选曲 | 12 | `evidence/solar-music-validation.json` |
| 实际太阳系 / 地球往返音乐状态 | 6 | `evidence/music-navigation-validation.json` |
| LOW、SAFE、手机 390×844、桌面 Earth 4K | 4 | `evidence/solar-texture-modes-validation.json` |
| 彩蛋曲播放及预报无缓存离线提示 | 3 | `evidence/earth-extras-validation.json` |
| Worker 当前日期 / 2030 回放、过滤、ISS 97 点轨道、位置推进 | 13 | `evidence/snapshot-worker-validation.json` |
| 服务器 Range、MIME、HEAD、缺文件、目录与刷新 | 16 | `test_server.py` |
| 普通 Python HTTP Server 主要入口 | 4 | `evidence/simple-server-validation.json` |
| 在线选点、同坐标刷新、内陆缺测、断网缓存、全球三图层、手动更新 | 11 | `evidence/live-weather-validation.json` |
| 选点接口的单位、UTC、缓存、超时与取消行为 | 16 | `evidence/point-forecast-module.json` |
| GFS 原始值、经纬度顺序、单位、分块 SHA256、回退与本地端点 | 62 | `evidence/live-global-verification.json` |
| 全球更新生命周期、轮询、离线偏好、重探测及请求竞态 | 25 | `evidence/weather-state-validation.json` |
| 浏览器开页自动获取、分钟检查、后台暂停与回前台合并事件 | 4 | `evidence/auto-weather-browser.json` |
| 选点面板自动刷新、前后台切换、聚焦及断网恢复 | 10 | `evidence/point-auto-refresh-validation.json` |
| 海洋影像与参考 6 图层在线 / 离线实绘 | 12 | `evidence/earth-services-validation.json` |
| 参考线首次显示及冷启动云瓦片 | 6 | `evidence/reference-startup-validation.json` |
| 真实地转分析、单期时间提示、高程及离线不取数 | 10 | `evidence/terrain-current-browser.json` |
| 新海洋服务自动检查、切回、离线和销毁竞态 | 13 | `evidence/earth-service-lifecycle.json` |
| 海洋缓存原子更新和 HTTP 接口等标准库测试 | 50 | `evidence/earth-services-python-validation.json` |
| 原始 NOAA 响应重新转换与随包 OACF 一致 | 4 | `evidence/current-source-reproducibility.json` |

**浏览器网络限制：**旧云瓦片加载在早期与一次跨页全站回归中出现过 `ERR_INVALID_HTTP_RESPONSE`；已改善连接复用与图层销毁处理，最终 6 次冷启动及新服务在线/离线测试未复现，但不能据此声称彻底排除瞬时错误。最近全站回归为 9/10：九项场景与导航通过，末项严格的零错误检查因该记录未通过。完整尝试记录保留于 `evidence/cloud-http-validation.json` 与 `evidence/repair-earth-validation.json`。

资源完整性见 `evidence/asset-integrity.json`。3D 验证包含实际 GPU 绘制、有效卫星坐标随时间变化、轨道数据、纹理、洋流不同帧画面及截图目视检查，并非仅检查 Canvas 存在。原站与本地截图均在 `evidence/`。动态时间、粒子不同，未宣称逐像素一致，也未穷举所有视角和任务组合。

`crawl-report.json` 汇总发现、下载、失败 URL、第三方资源、API、重定向、修复和最终测试。旧交付报告放在 `evidence/history-2026-10-05/`，其“8 项通过”“只有一个页面”等结论不代表本次结果。

### 可选开发检查

运行网站无需这些测试依赖。标准库检查：

```powershell
python -B -m unittest test_server -v
python tools/audit-local.py
```

已安装 Node、Playwright 和 Chrome 时运行 `tools/verify-offline-solar.cjs`、`tools/verify-offline-earth.cjs`、`tools/verify-earth-extras.cjs`（默认端口 8766）。`tools/verify-snapshot-worker.cjs` 验证轨道 Worker。其他浏览器检查脚本也保存在 `tools/`。
