# 林珈诚 · 个人宇宙空间

可交互 3D 首页、自由探索模式、个人内容和完整太阳系图谱。

## 启动

需要 **Node.js 24+** 和 **Python 3.9+**。Windows 双击 `Start-Website.cmd`，首次启动自动安装 Node 依赖并构建。
然后打开 **http://localhost:5193/**，保持启动窗口运行。按 Ctrl+C 停止。

```powershell
npm ci
npm run build
npm start
```

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

[可后续补充的素材](docs/materials-needed.md)：个人照片、旅行照片与地点、作品说明与截图、指定公开的联系方式。

## 验证

```powershell
npm test
node --test atlas/tools/test-comet-orbit.mjs
python -B -m unittest discover -s atlas -p "test_*.py" -q
npm run build
```

摘要见 [整合验证记录](docs/integration-verification.md)。

## 仓库与部署

私有仓库：https://github.com/Mumao233/personal-web

此仓库保存整合网站的完整源码。克隆后按“启动”一节安装依赖并运行；本地私有数据库、上传文件、运行缓存和构建产物不包含在仓库中。
完整站包含 Node/SQLite 与 Python 服务，不能仅把静态 HTML 上传 GitHub Pages。正式上线需支持这两个服务的主机、HTTPS 及持久数据目录。

## 来源与许可

Atlas 来自 https://solar-system-atlas.pages.dev/solar/ 的本地化及后续扩展，详情见 `atlas/README.md`、`atlas/crawl-report.json`。
Noto Sans SC：SIL Open Font License 1.1，见 `public/fonts/OFL-NotoSansSC.txt`。
MediaPipe Tasks Vision 和 Hand Landmarker 模型：Apache-2.0，见 `atlas/solar/vendor/gesture/PROVENANCE.md` 与随附许可。
第三方捕获内容、音频及素材仍受各自许可约束；本仓库没有将所有素材统一声明为原创或重新授权。
