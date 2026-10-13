# 阿里云部署记录

当前使用域名 HTTPS：<https://mumao.site/>，太阳系为 <https://mumao.site/solar/>。以下保留历史部署记录；新部署按文末 v1.0.1 要求和 [版本发布流程](../docs/releases.md) 操作。

## 首次部署记录（仅 HTTP 阶段）

- 地址：http://8.138.100.213/
- 太阳系：http://8.138.100.213/solar/
- 实例：i-7xvfvftrswzogb3o6n05，cn-guangzhou
- 首次部署：2026-10-13
- 环境：Node.js 24.21.0（官方发布包 SHA256 校验通过）、Ubuntu Nginx、Python 3.14
- 应用目录：/opt/personal-web/app
- 持久数据：/opt/personal-web/data（SQLite 一致性备份及上传文件）
- 运行账户：personal-web；Node 仅监听 127.0.0.1:5193，Python 子服务仅监听回环。
- systemd：personal-web.service，已启用开机启动和失败自动恢复。
- Nginx：/etc/nginx/sites-available/personal-web，转发公网 80 端口。
- 对应配置保存在 deploy/。升级前备份持久数据，不要用本地旧数据库覆盖服务器数据。

### 当时的验证

生产构建成功，21 项本地测试通过。公网主页、太阳系、主 JS/CSS、手势模型返回 200。
/api/health 返回 atlas:true；/api/status 返回 needsSetup:false。
匿名后台返回 401；/api/setup 返回 403；数据库、.env、服务器源代码路径返回 404。
systemd 确认 active (running)、enabled，Node 与 Python 均在服务进程组内。

### 当时的使用边界

用户选择暂时使用 IP。当前只有 HTTP，摄像头手势需要日后配置 HTTPS。
管理员沿用原本地网站账号；HTTP 连接下不要输入管理员密码或提交敏感私密内容，待 HTTPS 配好再使用。
本次未购买域名或变更阿里云安全组。80 端口原已可达。
凭据保存在本机 Workbench 配置，不在项目或部署包中。

## 2026-10-13 HTTPS 更新

域名 https://mumao.site 已绑定，Let's Encrypt 证书到期日 2027-01-10，certbot.timer 自动续期已启用，renew --dry-run 通过。
经用户确认，安全组 sg-7xvahy1g8pzm7xihjpfp 新增 TCP 443 入站来源 0.0.0.0/0。
公网 HTTPS 主页、太阳系及健康接口均返回 200；浏览器太阳系界面已加载，手势默认关闭。未实际开启摄像头做动作测试。
服务器 HTTP 到 HTTPS 返回 301，但公网 HTTP 被阿里云 Non-compliance ICP Filing 页面拦截（403）。需完成 ICP 备案才能消除此上游拦截；HTTPS 当前可达不代表备案完成。
早期仅 HTTP 的说明已由本段更新；直接使用域名 HTTPS，IP 不在证书覆盖范围。

## 2026-10-13 内容管理与问卷更新

升级包括三个内容栏目的图文编辑／独立文章／草稿发布隔离、矩阵题与提前结束／排他规则、统计看板，以及自定义个人资料栏目。简介和个人自述保持原样。

部署前将 SQLite 做一致性备份，上传文件单独归档。此次备份目录为 `/opt/personal-web/backups/rich-publishing-20261013-v1`；切换时保留旧应用为同目录下 `app-previous`。新代码在独立应用目录安装依赖后替换，持久数据目录保持 `/opt/personal-web/data`，没有导入本地测试数据。

应用目录中的 `release.json` 记录对应 Git commit；本地源码与 GitHub 同步，构建输出不提交 Git。回滚时停止服务，将旧应用目录恢复至 `/opt/personal-web/app` 后启动；除非明确需要回滚用户内容，不要恢复旧数据库。

验收使用隔离数据：图文编辑、图片粘贴上传、环绕及手机堆叠、草稿隔离、更新发布；矩阵必答、排他选择、提前结束与筛选导出；自定义资料链接及排序。所有功能测试数据都只在本地临时库。

最终本地生产构建通过，49 项自动化测试全部通过。手机验收宽度为390px；数据校验、权限与旧问卷测试同时通过。

## v1.0.0 正式版本

2026-10-13 将上述已部署、已验证的完整网站定为 `v1.0.0`。此次仅更新版本与发布文档，不改动运行逻辑或数据库；服务器保留现有构建，`release.json` 新增语义版本并记录发布提交。版本元数据更新前备份至 `/opt/personal-web/backups/v1.0.0-metadata`，无需重启服务。

以后更新遵循 [版本发布流程](../docs/releases.md)：完成验证后自动升版、同步 GitHub、备份部署并发布 GitHub Release。生产数据不随源码回滚。

## v1.0.1 升级要求

本版涉及应用代码、Sharp 图片处理依赖、Nginx 和 systemd 配置。必须在 Linux 部署目标安装对应依赖，不能把 Windows 的 `node_modules` 复制上去。前端 `dist` 可在本地构建后随源码部署；小内存服务器应采用这一方式，避免在线构建挤占正在运行的网站资源。数据库和上传目录继续使用 `/opt/personal-web/data`，先做 SQLite 一致性备份及上传文件备份，再切换应用；保留旧应用以便回滚。

### 管理员初始化

生产模式在应用层关闭 HTTP `/api/setup` 及其大小写、尾斜线路径别名；Nginx 的大小写无关规则提供第二层阻断。已有管理员无需重建，新空数据库只能在服务器本机运行：

```sh
cd /opt/personal-web/app
sudo -u personal-web env DATA_DIR=/opt/personal-web/data /usr/local/bin/node server/init-admin.js
```

按交互提示输入用户名和密码，不把密码写在命令行参数中。命令遇到已有管理员会拒绝覆盖；它不是重置密码工具。不要在生产配置 `TEST_MODE`。

### 可写目录与媒体

systemd 使用固定 `ExecStartPre` 命令创建并设置 `/opt/personal-web/data` 与 `atlas/.runtime` 的属主及权限，主进程仍以 `personal-web` 用户运行。可选 `ReadWritePaths` 避免首次目录缺失在初始化之前使服务失败；新配置要先通过 `systemd-analyze verify`，更换 unit 后执行 daemon-reload，再重启验证。

`data/media-incoming` 是上传处理的临时原件目录，处理完成后清理；`data/media-cache` 保存清洗副本。不得把这些目录额外配置为 Nginx 静态目录。所有 `/uploads` 请求必须经过 Node 的当前公开引用检查：无公开引用时要求管理员会话，公开共享文件按仍然有效的引用继续提供，并设置 `private, no-store`。

旧图片按需生成净化副本，不删除私有原文件。新上传在保存前移除图片元数据，并预填净化缓存，避免首次访问再次压缩。原数据与备份中仍可能有旧照片元数据；本次升级不等于删除私人备份。PDF 保持原字节。

本站绝对媒体链接通过可信 `PUBLIC_ORIGINS` 识别，默认包含 `https://mumao.site`、`http://mumao.site` 与历史 `http://8.138.100.213`。更换域名时在服务环境变量中显式配置逗号分隔的可信来源，不使用请求的 Host 头决定哪些文件公开。

### 通知与旧数据兼容

旧文章、旧上传、旧答卷继续保留。旧天气缓存从已验证分块恢复完整网格，新提交最后切换 manifest，不覆盖仍被使用的整网格文件。

启动时检查旧通知任务：能匹配问答的补齐关联信息；原问答已不存在的任务取消并清除敏感载荷；上次在发送期间中断的任务标为交付状态不确定，等待管理员核实后决定是否重试。不要为验收向真实收件人发送通知。通知网站地址须为有效公网 origin，缺少或无效时应修正配置。

### 发布验收

本节是升级操作与验收要求，不表示这些服务器检查已经执行。发布者需要记录实际结果、发布提交和备份位置：

1. 安装依赖、运行必要回归与生产构建；保留部署前一致性备份与旧应用。
2. 检查新 Nginx 配置 `nginx -t` 和 systemd unit，再加载配置并确认服务运行、Node/Python 仍仅监听回环。
3. 通过 HTTPS 检查首页、太阳系、`/api/health`、`/api/status` 和地形署名链接。使用读取型检查核对初始化路径别名被拒绝，避免在生产发送初始化请求。
4. 检查实际数据保留、匿名后台拒绝、媒体路由未被静态映射绕过。涉及写入的功能回归使用隔离数据库，不能向生产问卷或作品插入测试记录。
5. `release.json` 写入 `version: "1.0.1"` 与实际发布提交；核对线上清单、远端 main、附注标签及 GitHub Release 一致后再报告发布完成。

详细变更及回归位置见 [v1.0.1 审查整改](../docs/v1.0.1-review-fixes.md)。Linux Nginx/systemd、真实摄像头和外部邮件／短信的验收不得由本地模拟测试替代。

### v1.0.1 已完成的部署前验证

- Node 回归 99／99、Python 60／60、彗星轨道 20／20 通过，生产构建通过。
- 真实浏览器验证资料两窗口冲突保留本地修改、重新载入新版，以及问卷未保存离开选择。
- 在真实 Linux 上使用独立 oneshot unit，保留同样的 `User`／`Group`、`ExecStartPre=+ install`、`ProtectSystem=strict` 与可选 `ReadWritePaths`；从不存在的 data／runtime 目录启动成功，`Result=success`、退出码 0，两目录正确创建且 `personal-web` 可写。

这些是部署前和隔离检查的实际结果，尚不代替新版本正式服务切换、Nginx 加载及线上版本一致性的验收记录。

### v1.0.1 实际部署结果（2026-10-13）

- 首次尝试在服务器构建时命令超时，SSH／云助手与 HTTPS 暂时失去响应；用户补充实例重启权限后执行正常重启，旧站恢复，SQLite 完整性检查通过。随后使用本地已验证的前端构建，不再在该 2 GB 级实例运行 Vite 构建。
- Linux 重新安装依赖，Sharp 原生库可用；图片隐私专项 10／10 通过。网关测试先因 shell 未指定 `PYTHON` 而找不到 `python`，补上与生产 unit 一致的 `/usr/bin/python3` 后 1／1 通过。
- 切换前备份到 `/opt/personal-web/backups/v1.0.1`：一致性 `space.sqlite`、`uploads.tar.gz`、旧 Nginx／systemd 配置，以及 `app-previous` 完整旧应用。切换脚本提供失败时恢复旧应用的路径，不恢复旧数据库覆盖新增内容。
- 保留原 Atlas 运行缓存；Nginx 只更新 setup 路径规则，保留现有 TLS 证书与配置。`nginx -t` 通过，正式 systemd 服务 `active/running`、开机启动已启用，启动后无自动重启。
- 切换前后数据库内容与设置摘要、全部上传原件摘要一致；SQLite 完整性正常。原有 4 个项目、1 份问卷、2 份答卷和 1 个上传文件保留，没有向生产写入验收内容。
- 公网 HTTPS 首页、太阳系、健康接口、状态接口和地形署名均为 200；健康接口 `atlas:true`，初始化状态 `needsSetup:false`。匿名后台及大小写别名为 401，setup 别名为 403，敏感文件路径为 404。
- 现有公开图片匿名返回 200，带 `private, no-store`，响应图片无 EXIF／XMP／IPTC；未修改私有上传原件。
- 部署源码逐文件核对 Git 内容，前端包校验 SHA-256。准确发布提交与版本记录在应用目录的 `release.json`，对应附注标签 `v1.0.1`。

## v1.1.0 助手管理入口发布

本版增加五类内容的本机管理入口、本机预览、媒体上传、幂等回执及整批事务，不新增公网端点、服务账号、sudo 规则、ACL 或长期凭据。调用说明见 [助手管理指南](../docs/assistant-admin.md)。既有 Workbench 可用的运维权限没有缩减，执行仍依赖本机桌面在线。原随笔专用脚本保留兼容。

依赖版本未变化，继续使用现有 Linux 依赖；前端只在本机构建后上传，禁止服务器构建。最终代码提交后重新打包，不使用暂停任务留下的 `.qa/v1.1.0-update.tar.gz`。部署前保留 `/opt/personal-web/backups/v1.1.0` 下的一致性数据库备份、上传文件及旧应用；更新不迁移、不初始化生产数据库。助手草稿及回执使用现有 records 表的独立种类，不写入公开问卷定义或资料字段。保留 Atlas 运行缓存以及原 Nginx／systemd／TLS 配置。

生产验收仅通过真实本机入口运行 `list/get/preview` 与引用媒体读取，不运行 `apply` 或上传测试媒体，不发布虚构内容。写入、并发、重复请求及故障恢复全部在隔离数据库执行。实际提交、备份位置和本地／Linux／线上验证结果以服务器 `release.json` 和同名 GitHub Release 为准；本节规定流程，不将尚未执行的操作视为通过。

回滚先停止 `personal-web.service`，保留当前应用目录，再把上述备份的 `app-previous` 恢复为 `/opt/personal-web/app` 并启动服务。正常应用回滚不恢复旧数据库或上传文件，避免覆盖部署后新内容；旧版本会忽略助手草稿和回执记录。若同时需要恢复用户数据，必须先明确确认恢复范围。停用助手入口只影响新脚本调用，不撤销既有 Workbench 运维权限。
