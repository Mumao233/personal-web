# 按 v2 设计稿重做公开页面

## 改动范围

- **公开页面**：首页、关于我、作品与项目及详情、随笔列表及文章页、关于世界、关于你（问卷列表和答题页）、关于我们、页面不存在，全部按新设计稿重做。
- **去掉**：3D 星球首页、欢迎动画、换句、「自由探索」和公开页面的主题切换按钮。Three.js 现在只在 `/solar/` 和关于世界的地球里加载。
- **样式**：新增 `src/design-tokens.css` 和 `src/public/*.css`，全部限定在 `html[data-surface="public"]` 下。旧样式保持原内容，改由后台 chunk 按原层叠顺序加载。
- **字体**：Noto Serif SC（可变字重 400–700，101 片）和 Instrument Serif 自托管，脚本 `scripts/build-fonts.mjs` 可重复运行。`/fonts/` 下的 woff2 设一年 immutable 缓存，`.css` 不变。
- **首屏图**：`scripts/build-hero-images.mjs` 生成 2560 / 1280 的 AVIF、WebP、JPEG。141MB 的原图 PNG 超过 GitHub 上限，已写入 `.gitignore`，请自行保留。
- **六个组件**：共享元素过渡、悬停预览、照片查看器 FLIP、分段控制器、骨架屏、堆叠通知。
- **后端**：只给静态字体加了缓存头，接口和数据结构未改。

## 截图

| 页面 | 桌面 1440 | 手机 390 |
| --- | --- | --- |
| 首页 | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/home-desktop.png) | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/home-mobile.png) |
| 文章 | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/article-desktop.png) | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/article-mobile.png) |
| 作品 | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/projects-desktop.png) | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/projects-mobile.png) |
| 关于我 | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/about-desktop.png) | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/about-mobile.png) |
| 留言 | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/us-desktop.png) | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/us-mobile.png) |
| 问卷 | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/survey-desktop.png) | ![](https://raw.githubusercontent.com/Mumao233/personal-web/feat/redesign-v2/docs/design-v2/screenshots/survey-mobile.png) |

截图里的内容都是隔离数据库中的合成数据，不是线上内容。

## 验证结果

- `npm test`：328 项全过（改动前 316 项）。`npm run build` 通过。
- 删除或重写的测试：换句 2 项、欢迎动画 1 项、自由探索 4 项、毛玻璃菜单 2 项，这些功能已移除；另有欢迎动画相关的存储测试改为测交接数据。
- Chrome，1440 和 390 宽，12 条路由：无横向滚动、文字溢出、元素重叠，点击区域不低于 44px（地图标记用透明热区补足）。
- 键盘：Tab 走完首页 29 个焦点，都有可见焦点框。
- 减少动态：跨文档过渡关闭，查看器不做 FLIP，分段滑块和手机菜单降级正确。
- 共享元素过渡：随笔标题、作品封面、影像封面三处，在 Chromium 中确认过渡组生成。
- 通知：成功 4 秒消失、失败需手动关闭，polite / assertive 正确。留言和问卷提交都写入隔离数据库。
- 后台：和 `origin/main` 对比 7 个栏目、深浅两种主题，计算样式差异 0，截图逐像素一致。
- `/solar/`、`/nine-grid/`：返回 200，无脚本错误。`atlas/` 和 `apps/nine-grid/` 源码相对 main 没有改动。

## 没做或未验证

- **未验证**：Safari、Firefox、真机触屏、屏幕阅读器实际朗读。
- **未验证**：线上数据。本机连 mumao.site 时 TLS 握手失败，线上资料字段和内容条数没有核对过。
- **未验证**：后台的编辑表单和预览，只比对了 7 个栏目的列表视图。
- **未验证**：`/solar/` 和 `/nine-grid/` 没有做改动前后的像素对比，依据是源码未变、页面能正常打开。
- **未验证**：线上 Nginx 之后的实际缓存头，只在本机 Express 上确认过。
- **未做**：升版本、部署、打标签、发 Release，等合并后再执行。
- **待补内容**：首屏照片的拍摄日期（目前只显示「广州」）。
- **待操作**：在后台关掉电话和出生日期的「在网站展示」开关，保存一次，才能把它们从 `/api/public` 里清掉。前端已不渲染这两项。

## 需要留意

- 自我介绍用的是后台资料里的 `profile.intro`，没有用设计稿里的文字，因为 AGENTS.md 规定简介只在明确要求时才改。
- 手机上 `sizes` 按图片实际显示宽度计算，多数手机会下载 2560 版（AVIF 约 172KB），否则 440px 高的图会发虚。

## 和 Codex PR 的冲突

无。仓库目前没有打开的 PR，远端只有 `main`，Codex 的三个分支都已合入，工作区干净。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
