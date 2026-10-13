# 个人宇宙空间

可交互 3D 首页、自由探索模式、个人内容和完整太阳系图谱。

## 启动

需要 **Node.js 24+** 和 **Python 3.9+**。Windows 双击 `Start-Website.cmd`，首次启动自动安装 Node 依赖并构建。
然后打开 [http://localhost:5193/](http://localhost:5193/)，保持启动窗口运行。按 Ctrl+C 停止。

```powershell
npm ci
node server/init-admin.js
npm run build
npm start
```

`init-admin.js` 只用于新数据库首次创建管理员，按提示在本机输入用户名和密码；已有管理员时会拒绝覆盖，可以跳过。生产模式（`npm start`）关闭所有 HTTP 初始化入口。不要将密码写进命令参数或提交到仓库。

开发：`npm run dev`。使用 `PORT` 修改端口，`PYTHON` 指定 Python 路径。
Node 自动启动仅监听本机随机端口的 Atlas Python 子服务，无需另外运行太阳系原来的启动脚本。

## 体验

- 首页真实 Three.js 场景与滚动镜头过渡；「自由探索」可旋转、缩放及选择六个栏目，退出返回之前的阅读位置。
- 首页太阳系作品入口在同一标签页打开 `/solar/`，顶部可返回个人主页。
- 保留关于我、作品与项目、随笔、线条地球照片、问卷、公开/私密留言与管理员后台。
- 保留太阳系轨道目录、地球、海洋、天气自动更新和离线回退。来源的发布频率及快照限制见 `atlas/README.md`。
- 彗星按椭圆几何显示，轨道与标记共用坐标变换，支持完整轨道/彗核聚焦。全景为示意尺度；旧轨道元素不代表今日精密星历。

## 摄像头手势

太阳系右下「手势控制」**每次打开网页默认关闭**。主动开启才申请摄像头、加载本地 MediaPipe 模型。视频在浏览器里分析，不上传服务器；关闭、离开或切到后台会停止摄像头。

捏合移动旋转，双手捏合拉开/靠拢缩放；选择/平移模式下捏合选择或拖动。具体操作、开源库和验证见 [手势控制](docs/gesture-control.md)。
公网使用摄像头需要 **HTTPS**；localhost 可直接使用。真实摄像头的光照、角度与动作体验需在使用者设备上试用。

## 内容与数据

本地 `data/space.sqlite` 保存原个人站的一致性备份，照片在 `data/uploads/`。这些私人数据不会提交 Git。
新克隆仓库会创建基础内容与新数据库；本地副本保留原管理员和内容。后台操作见 [原需求记录](docs/requirements.md)。邮件/短信需配置用户自己的服务，未配置不代表可送达。

作品、随笔和照片故事支持可视化图文编辑、图片环绕、独立阅读链接，以及分开的草稿和正式发布版本。操作方法见 [图文发布指南](docs/rich-publishing.md)。

问卷支持矩阵量表、选项触发提前结束、排他选择、分布统计与 Excel／CSV 导出；个人资料支持自定义栏目、链接和排序。操作方法见 [问卷与资料栏目](docs/survey-and-profile.md)。

资料、问卷和文章的过期编辑会触发版本冲突，不会直接覆盖其他窗口的新内容；编辑器提供保留本地修改与重新载入入口。问卷提交绑定实际展示的题目版本，网络重试不会重复保存同一次提交。

上传图片会清除 EXIF／IPTC／XMP 元数据，并处理方向与色彩。草稿、撤下和未被公开内容引用的媒体需要管理员登录；已公开内容仍引用的共享文件继续可访问。旧照片经服务器清洗副本提供，私有数据目录中的原文件不会被此升级删除。

[可后续补充的素材](docs/materials-needed.md)：个人照片、旅行照片与地点、作品说明与截图、指定公开的联系方式。

## 验证

```powershell
npm test
node --test atlas/tools/test-comet-orbit.mjs
python -B -m unittest discover -s atlas -p "test_*.py" -q
npm run build
```

摘要见 [整合验证记录](docs/integration-verification.md)。

v1.0.1 发布前验证：Node 99 项、Python 60 项、彗星轨道 20 项通过，生产构建通过。真实浏览器检查了资料并发冲突恢复和问卷未保存离开提示；生产部署状态另见部署记录。

## 仓库与部署

源码仓库：https://github.com/Mumao233/personal-web

线上网站：https://mumao.site/ · [阿里云部署记录](deploy/README.md)

当前版本：**v1.0.1**。版本变化见 [更新日志](CHANGELOG.md)，本次审查整改见 [报告逐项对照](docs/v1.0.1-review-fixes.md)，发布约定见 [版本发布流程](docs/releases.md)。

此仓库保存整合网站的完整源码。克隆后按“启动”一节安装依赖并运行；本地私有数据库、上传文件、运行缓存和构建产物不包含在仓库中。
完整站包含 Node/SQLite 与 Python 服务，不能仅把静态 HTML 上传 GitHub Pages。正式上线需支持这两个服务的主机、HTTPS 及持久数据目录。

## 来源与许可

Atlas 来自 https://solar-system-atlas.pages.dev/solar/ 的本地化及后续扩展，详情见 `atlas/README.md`、`atlas/crawl-report.json`。
Noto Sans SC：SIL Open Font License 1.1，见 `public/fonts/OFL-NotoSansSC.txt`。
MediaPipe Tasks Vision 和 Hand Landmarker 模型：Apache-2.0，见 `atlas/solar/vendor/gesture/PROVENANCE.md` 与随附许可。
第三方捕获内容、音频及素材仍受各自许可约束；本仓库没有将所有素材统一声明为原创或重新授权。
