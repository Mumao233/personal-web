# 海洋遥感影像

这些 PNG 来自 NASA EOSDIS GIBS 的公开 WMS 服务，包含真实产品影像和原始官方图例。没有补造云遮挡、陆地或未观测区域的数据。所有无数据区域保留透明通道。

| 本地产品 | 来源产品 | 随包快照日期 | 时间含义 |
|---|---|---|---|
| `sst` 海表温度 | JPL / GHRSST MUR L4 | 2026-10-10 | 每日海表温度分析，不是即时现场测量 |
| `salinity` 海表盐度 | JPL / SMAP CAP L3 | 2026-10-07 | 8 日滑动平均产品的标记日期 |
| `chlorophyll` 叶绿素 a | Ocean Biology DAAC / Aqua MODIS L2 | 2026-10-11 | 日卫星影像，云遮挡和卫星观测范围造成空缺 |

来源服务：<https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetCapabilities>

通过 `server.py` 启动时，`ocean_services.py` 会读取该能力文档公布的实际可用日期，每 6 小时检查更新；短暂失败后至少等待 15 分钟，手动刷新至少间隔 5 分钟。新数据写入 `.runtime/ocean/`，不会覆盖随包快照。缓存或断网状态、产品日期、来源及检查时间由本地 API 返回。联网检查成功的 `live` 状态只表示来源连接成功，不代表产品没有发布延迟。

运行时缓存使用不可变的 SHA-256 分代文件和最后原子提交的 `current.json` 指针，最多保留最近 4 代；图片 URL 的版本参数锁定对应内容，防止更新时旧元数据搭配新图像。随包快照始终保留。

影像为全球 EPSG:4326、1024 × 512 像素，边界为经度 -180 到 180、纬度 -90 到 90；显示分辨率不等于原始科学产品分辨率。颜色由 GIBS 原图例定义，不从颜色反推或伪造数值。各目录 `metadata.json` 记录原始请求 URL、产品日期、下载时间及 SHA-256。

使用 NASA 公开 Earth science imagery 时保留 NASA EOSDIS GIBS 和相应科学产品署名；此副本没有对上游素材另行声明独占版权或 CC BY 授权。
