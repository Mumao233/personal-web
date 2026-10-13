# Friday 随笔草稿委托

> v1.1.0 保留本页所述草稿专用入口以兼容已有调用。新任务优先使用 [完整助手管理入口](assistant-admin.md)，覆盖五类内容、媒体、本机预览、明确发布和幂等批量；本页的窄范围限制仅指 `essay-drafts-cli.js`，不代表完整入口的能力。

用户在 Friday 对话中明确指定新建哪篇草稿、读取哪篇或修改哪些内容；Friday 将这次操作委托给已连接的本机 Codex 执行器。执行器使用现有 Workbench 认证调用服务器的 `server/essay-drafts-cli.js`，返回草稿 ID、版本或错误。无需用户另外开启一个 Codex 对话。

这是已验证的本机执行链，不是新建 MCP、GPT Actions 或公网 API。它依赖本机 Windows 电脑在线、Codex 执行环境可用以及 Workbench 现有认证有效；关闭电脑后不能继续执行，也没有自动后台写稿任务。

## 操作与权限

| 命令                                       | 作用                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| `list`                                     | 返回未发布随笔的 ID、标题、revision、草稿保存时间    |
| `get ID`                                   | 读取一篇未发布随笔的草稿可编辑字段                   |
| `create`                                   | 从标准输入 JSON 新建未发布随笔，必须带 `revision: 0` |
| `update ID`                                | 从标准输入 JSON 修改草稿，必须带刚读取的 revision    |
| `create --dry-run` / `update ID --dry-run` | 在只读数据库连接中校验输入及版本，不保存内容         |

仅访问 `records.kind='posts'`。已发布随笔及其待更新草稿不能读取或修改。输出和输入限于 `title`、`body`、`content`、`excerpt`、`category`、`date`，输出另含 ID、revision 与草稿保存时间。不会返回个人资料、问答、问卷、通知配置或私有上传文件。

脚本不提供发布、撤下、删除、密码管理、上传或媒体读取命令。未知参数、指定其他模块、注入 `published`、`id`、`draft`、位置等字段均被拒绝。管理员继续在网站后台审阅并手动发布。

**这限制的是草稿脚本的行为，没有缩减本机执行器或 Workbench 原有的运维权限。** 不应将现有 Workbench 认证交给独立外部身份，或宣称它已经变成草稿专用凭据。本次没有新增 sudo 规则、ACL、服务账号、长期密钥或网络端点。

## 真实调用

在本机 PowerShell，沿用已安装的 CLI：

```powershell
$workbenchPath = 'C:\Users\Mumao\AppData\Local\Programs\workbench\workbench.exe'
& $workbenchPath exec --instance-id 'i-7xvfvftrswzogb3o6n05' --region 'cn-guangzhou' --output json --command 'sudo -n -u personal-web env DATA_DIR=/opt/personal-web/data /usr/local/bin/node /opt/personal-web/app/server/essay-drafts-cli.js list'
```

Workbench 的 `stdout` 是一行 JSON。成功时 `ok:true`、退出码 0；拒绝或失败时 `ok:false`、退出码 1，含 `status`。409 同时带 `code:"REVISION_CONFLICT"`，必须重新读取再由用户决定如何合并，不能自动拿新 revision 强制重试旧正文。

读取前校验 ID，不把用户原话拼接到远程 shell 命令：

```powershell
$draftId = '从 list 返回的实际 ID'
if ($draftId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$' -or $draftId -eq 'new') { throw '无效草稿 ID' }
& $workbenchPath exec --instance-id 'i-7xvfvftrswzogb3o6n05' --region 'cn-guangzhou' --output json --command "sudo -n -u personal-web env DATA_DIR=/opt/personal-web/data /usr/local/bin/node /opt/personal-web/app/server/essay-drafts-cli.js get $draftId"
```

写入时先把用户授权的内容整理为 UTF-8 JSON 文件，放在不提交 Git 的本机临时目录。正文不得塞进远程命令参数。新建格式为 `{"revision":0,"title":"用户确定的标题","body":"用户授权的正文"}`；修改使用 `get` 返回的 ID 与 revision，仅传需要改变的字段。

执行器使用以下顺序，每次请求生成单独临时路径：

1. 使用 Workbench `exec` 在服务器运行 `mktemp -d /tmp/personal-web-essay-input.XXXXXXXX`，获得仅 root 可访问的临时目录。核对返回路径符合该固定前缀且不含其他字符，不允许由用户提供服务器路径。
2. 使用 Workbench `upload` 将该 JSON 文件上传到这个新目录的 `input.json`；先确认目标不存在。本次上传只走现有 Workbench 通道。
3. 执行 `sudo -n -u personal-web env DATA_DIR=/opt/personal-web/data /usr/local/bin/node /opt/personal-web/app/server/essay-drafts-cli.js create --dry-run < /tmp/实际目录/input.json`。修改则使用已校验的 `update ID --dry-run`。输入重定向由现有 Workbench 的 root shell 打开，因此不需要给应用用户新增读取权限。
4. dry-run 成功后，按已授权的同一操作移除 `--dry-run` 并执行，解析返回 JSON。保存只改变草稿与 revision，不改变正式发布字段。
5. 无论成功或失败，核对并删除这次固定临时目录中的 `input.json`，再用 `rmdir` 删除已空目录；不要递归删除其他路径。及时清理本机临时 JSON。

只读 `list/get` 不需要临时目录。生产发布验收只执行 `list/get` 或无写入 dry-run，不能为验收创建虚构随笔。

## 内容与并发

标准输入最多 1 MiB；字段长度和富文本结构使用网站现有校验，正文最多 20 万字，不接受任意 HTML 或视频节点。`content` 是网站已有受限图文 JSON。仅改标题时保留原正文与格式；提供 `body` 会把正文整体替换为纯文字文档，旧的加粗、插图等排版不保留。需要保留排版时读取并修改 `content`。同时显式提供两者时以 `content` 为准。

数据库目录必须用绝对路径 `DATA_DIR` 明确指定，数据库必须已存在；脚本不会建库或导入种子数据。list/get/dry-run 使用 SQLite 只读连接。写入使用 `BEGIN IMMEDIATE`，锁定后才读记录和校验版本，与后台草稿保存复用事务及字段校验。后台发布、撤下和兼容保存也在事务中检查版本并写入，避免跨进程竞争。

## 停用与恢复

不再委托草稿操作即可停止此流程；需要停用服务器入口时通过正常发布移除脚本。没有新的凭据需要吊销，也没有新增公开接口需要关闭。原有 Workbench 运维访问仍然存在，若用户希望撤销它，应单独处理原认证，不能把移除脚本视作撤销运维权限。

备份和回滚遵循 [发布流程](releases.md) 与 [部署记录](../deploy/README.md)：保存数据库一致性备份、上传文件及旧应用；应用回滚不覆盖部署后新增的数据。本方案不接入付费模型，不把文章传给新模型服务，也不包含朋友圈抓取或导入。

隔离测试见 `tests/essay-drafts-cli.test.js`，覆盖读取隔离、未发布保存、已发布拒绝、参数与字段注入、正文校验、revision 冲突、并发、dry-run 无写入及 SQLite 失败回滚。
