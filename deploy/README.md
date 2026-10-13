# 阿里云部署记录

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

## 验证

生产构建成功，21 项本地测试通过。公网主页、太阳系、主 JS/CSS、手势模型返回 200。
/api/health 返回 atlas:true；/api/status 返回 needsSetup:false。
匿名后台返回 401；/api/setup 返回 403；数据库、.env、服务器源代码路径返回 404。
systemd 确认 active (running)、enabled，Node 与 Python 均在服务进程组内。

## 使用边界

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
