# Friday / Codex 内容管理入口 · v1.2.0

此入口让已连接本机执行环境的 Friday / Codex 查询、整理、保存草稿，并在用户明确指定内容和目标、核对预览后代为发布。它使用本机现有阿里云 Workbench 认证，不新增公网管理接口、账号、密钥、SSH 配置或长期授权。旧的[随笔草稿脚本](essay-drafts-cli.md)保留；新工作流统一使用本文入口。

**依赖本机 Windows 电脑在线、执行环境可用、Workbench 认证有效。** 仅有聊天窗口而没有本机工具调用能力的助手不能执行此脚本；它也不是关闭电脑后仍会运行的云端自动任务。

## 模块与操作

| 模块 `kind`           | 查询                 | 新建 / 修改草稿            | 预览 / 发布                  | 下架                                   |
| --------------------- | -------------------- | -------------------------- | ---------------------------- | -------------------------------------- |
| `posts` 随笔          | 列表、单篇           | 支持                       | 支持                         | 停止公开展示，保留内容                 |
| `projects` 作品与项目 | 列表、单篇           | 支持                       | 支持                         | 同上                                   |
| `stories` 照片故事    | 列表、单篇           | 支持，保留地点与相册       | 发布精确地点必须明确确认     | 同上                                   |
| `surveys` 问卷定义    | 仅定义，无答卷或统计 | 支持助手专用草稿           | 支持                         | 停止接收新答卷，保留历史答卷与题目版本 |
| `profile` 个人资料    | 单一 `id: "profile"` | 修改草稿，不创建第二份资料 | 支持；简介与自述另需明确授权 | 不支持整页下架；编辑字段可见性后发布   |

原网站后台中，个人资料和问卷仍然直接保存生效；助手的这两类草稿独立保存。网站后台改过正式内容后，旧助手草稿会标为过期，不能直接发布覆盖。随笔、项目和照片故事复用原有草稿机制。

不接入问答、举报、通知、答卷、访客资料、账号、安全设置、任意 SQL 或系统命令。没有删除操作，也没有批量全库替换。视频、内置 AI 写作侧栏和朋友圈导入不在本版范围。

## 调用入口

在项目根目录运行：

```powershell
node scripts/admin-workbench.mjs --input .qa/request.json
node scripts/admin-workbench.mjs --input .qa/preview-request.json --preview-dir .qa/admin-previews
node scripts/admin-workbench.mjs --help
```

输入是 UTF-8 JSON 文件；输出是一行 JSON，`ok: true` 时本机退出码为 0，否则为 1。请求文件、下载的媒体和本机 HTML 含有私有草稿，只放在 `.qa/` 或受保护的本机目录，不提交 Git。不要把密码、Cookie、云凭据或任意命令放进请求。

传输固定使用：

- CLI：`C:\Users\Mumao\AppData\Local\Programs\workbench\workbench.exe`
- 实例：`i-7xvfvftrswzogb3o6n05`；地域：`cn-guangzhou`
- 服务脚本：`/opt/personal-web/app/server/admin-cli.js`
- 数据目录：`/opt/personal-web/data`；运行身份：`personal-web`

本机脚本不接受服务器、凭据或 shell 命令参数。它创建受限的临时目录，将 JSON 上传为文件，交给固定服务器脚本的标准输入。输出通过文件下载，避免命令输出截断和正文进入 Workbench 命令日志。无论成功失败都会尝试清理本次临时文件，清理失败会返回警告。

同一 Workbench 实例的操作必须串行。本入口使用本机临时目录中的进程间协调锁，覆盖每次请求的传输、执行和清理；另一助手同时调用时返回 `ADMIN_BUSY`，等待前次完成后再用原请求重试。仅当锁明确属于本工具且持有它的进程已经退出时，才自动回收；无法确认时保留锁并报告忙碌。锁不是凭据，也不是长期授权。它只能协调此包装脚本，**不能阻止其他工具直接调用 Workbench**；部署、运维或手动命令也不要与此入口并行执行，否则共享连接可能发生超时或响应混杂。

**这些限制只约束此脚本的行为，不隔离或缩减 Workbench 原有运维权限。** `approved: true` 是执行者已经取得用户明确授权的声明，并非独立身份认证或无法伪造的用户签名；助手仍必须遵守下面的操作规则。不要把现有 Workbench 凭据交给外部身份。

## 查询与版本

```json
{ "action": "list", "kind": "posts", "offset": 0, "limit": 50 }
```

```json
{ "action": "get", "kind": "posts", "id": "从列表取得的真实ID" }
```

个人资料使用 `{"action":"get","kind":"profile","id":"profile"}`。返回的单项包含 `kind`、`id`、`version`、`liveRevision`、`published`、`hasDraft`、`draft`、`live`、`stale`、`target`。`version` 是当前状态的摘要字符串，修改、发布、下架必须把刚读到的值原样传作 `expectedVersion`；不要自己计算、递增或替换版本。每次查询只覆盖指定内容模块。

版本冲突时停止写入，重新读取正式内容和草稿，先核对用户刚保存的改动，不能自动用新版本重试旧正文。个人资料或问卷助手草稿为 `stale: true` 时，须人工合并两份内容，并在 `update` 操作中提交**全部现有可编辑字段**和 `resolveStale: true`；它不能当作忽略冲突的快捷开关。

## 默认保存草稿

“写一篇”“整理一下”只授权保存草稿，不授权发布。单项草稿创建或修改可直接执行 `apply`；`requestId` 使用本次操作唯一且稳定的字符串，例如 UUID。相同请求重试须原样保留它和完整请求。

```json
{
  "action": "apply",
  "requestId": "5f2b75a4-cd7e-4bcd-b591-84b295bfbdeb",
  "operations": [
    {
      "action": "create",
      "kind": "posts",
      "data": {
        "title": "待整理的随笔",
        "body": "用户授权整理的正文",
        "category": "生活"
      }
    }
  ]
}
```

```json
{
  "action": "apply",
  "requestId": "9e4a3874-486b-4f96-bb5f-1d9fb9d139e0",
  "operations": [
    {
      "action": "update",
      "kind": "posts",
      "id": "真实ID",
      "expectedVersion": "从get返回的完整version",
      "data": { "title": "修改后的标题" }
    }
  ]
}
```

`data` 只包含需修改的字段。修改正文时使用网站现有图文 JSON `content`，保持原格式；显式提交 `body` 会替换为纯文字正文。支持段落、二/三级标题、加粗、斜体、删除线、链接、列表、引用、分隔线和图片。图片节点沿用现有格式，例如：

```json
{
  "type": "image",
  "attrs": {
    "src": "/uploads/上传结果中的实际文件名.png",
    "alt": "图片替代文字",
    "caption": "图片说明",
    "align": "left",
    "width": 50
  }
}
```

`align` 支持 `left`、`right`、`center`，`width` 为 25、50、75、100。手机窄屏上下排列。不要提交 HTML、脚本、视频节点或任意本机文件地址。

个人资料改 `intro` 或 `bio` 时，只有用户明确要求修改简介/自述，才在操作项传 `allowBioChange: true`；发布这些修改时同样需要该标志，不能让一次普通资料发布顺带带出未经核对的自述改动。资料字段 `fields` 数组顺序就是展示顺序，`visible: false` 隐藏栏目；姓名本体仍作为网站身份公开。

## v1.2.0：日期、照片位置与项目附件

以下片段是 `create` 或 `update` 操作中的 `data`，沿用上面的 `apply` 外层和版本检查。示例路径、日期、坐标与字节数仅说明格式，**执行时必须换成实际上传结果和用户确认的数据**。更新数组会替换整组：先读取原数组，保留不需要改变的条目，不要把示例直接覆盖到真实内容。

### 内容日期

`date` 使用真实有效的 `YYYY-MM-DD`，未知时为 `""`；不要填时间戳、依照电脑时区猜日期，或用今天代替未知拍摄日。`dateMode` 为 `auto` 或 `manual`：

- 新随笔、项目默认 `auto`，草稿可以保持空日期，**首次发布**才按 `Asia/Shanghai`（北京时间）确定日期；后续更新保留首次日期。
- 显式改日期时同时传 `dateMode: "manual"`，以后不会被自动填充覆盖。手动模式也允许空日期。
- 照片故事不会在发布时补今天。后台只会给新建、日期仍空且未手动指定的故事，采用同一批照片一致的 EXIF 日期；多个日期提供候选供人选择，追加照片不改写已有日期。助手应同样先核对候选，不能把上传时间当拍摄时间。
- 旧内容没有 `dateMode` 时保持已有日期，未更改的旧日期不会被强行重写。需要改旧日期时提交上述有效日历格式。

自动日期的新随笔片段：

```json
{
  "title": "整理中的随笔",
  "body": "用户授权的正文",
  "date": "",
  "dateMode": "auto"
}
```

明确指定拍摄日时可以仅更新：`{"date":"2026-10-11","dateMode":"manual"}`。日历日期按原样显示；带时区的旧时间戳如需显示为日期，统一使用上海时区，不随访客电脑时区改变。

### 照片及位置公开范围

`photos` 仍是按显示顺序排列的 URL 字符串数组。可选的 `photoDetails` 与它并存，每项为 `{src,alt,caption,takenAt,lat,lng}`；`src` 必须唯一且对应 `photos` 中的本站图片，最多 200 项。`alt` 最多 1000 字、`caption` 最多 2000 字，`takenAt` 为 `YYYY-MM-DD` 或 `""`。没有 GPS 时省略 `lat/lng`，不要编造零坐标。照片 GPS 仅用于后台资料，公开接口与阅读页会去除它们。

原有只有 URL 的相册仍可读取；旧相册中的外部 URL 未改动时可保留。新增或调整相册时使用上传得到的 `/uploads/...` 图片路径，`photoDetails` 不接受外部 URL。改变照片顺序时同步保留相应详情；移除照片时也移除该图片的详情。封面仍使用 `cover` 指向实际图片。

故事的原始 `lat/lng/location` 是后台资料。`publicLocation` 是明确给访客看的地名；不要把原始街道或家庭位置备注复制进去。`locationPrecision` 控制公开投影：

| 模式     | 发布要求                                                                           | 对访客的结果                                                  |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `city`   | 非空 `publicLocation`、独立选定且有效的 `cityLat/cityLng`、`confirmLocation: true` | 只公开城市名称与所选代表点，原始 GPS 不公开                   |
| `exact`  | 有效的原始 `lat/lng`、`confirmLocation: true`                                      | 公开原始坐标，以及明确填写的公开地名                          |
| `hidden` | 不要求坐标或位置确认                                                               | 从地图中隐藏，文章仍可阅读；仅展示明确填写的 `publicLocation` |

新故事默认 `city`；旧故事缺少 `locationPrecision` 时兼容原有精确位置行为，旧 `location` 只在该兼容状态下作为公开地名回退。选定新模式后，请明确填写 `publicLocation`。不能用原始 GPS、简单取整坐标或反查失败时的原坐标冒充城市代表点；城市点缺失就停止发布，保留草稿供用户手填或重新选择。

`confirmLocation` 确认的是**当前档位实际会公开的名称和坐标**，不能因为之前确认过精确点，就省略对新城市代表点的核对。位置、公开名称或档位改变后重新核对，再显式提交确认。导入 EXIF 不会授权外部地理查询；只有用户主动点击已说明的查询按钮，Nominatim 才收到选择的坐标或查询文字。助手不要为了补城市静默发送原始 GPS。

带照片的城市级故事片段（先用真实文件路径和用户选定的坐标替换示例）：

```json
{
  "title": "一次城市散步",
  "date": "2026-10-11",
  "dateMode": "manual",
  "photos": ["/uploads/example-photo.jpg"],
  "photoDetails": [
    {
      "src": "/uploads/example-photo.jpg",
      "alt": "沿江步道上的树影",
      "caption": "傍晚散步时拍摄",
      "takenAt": "2026-10-11"
    }
  ],
  "cover": "/uploads/example-photo.jpg",
  "locationPrecision": "city",
  "publicLocation": "广州",
  "cityLat": 23.1291,
  "cityLng": 113.2644,
  "confirmLocation": true
}
```

如果用户要求不公开坐标，可修改为 `{"locationPrecision":"hidden","publicLocation":"","confirmLocation":false}`。原始资料仍保留在后台，切换为隐藏不删除照片或文章。

### 项目 PDF 附件

只有 `projects` 接受 `attachments`，每个项目最多 20 项，每项为 `{src,name,size,version,date}`：

- `src` 取媒体上传响应 `files[].url`，必须是本站 `/uploads/*.pdf`；不要填本机路径、外部链接或重新拼接文件名。
- `size` 原样采用同一上传结果的 `files[].size`，单位为字节，整数且最多 **15MiB（15 × 1024 × 1024 字节）**。服务端还会核对实际文件大小及 PDF 内容；不能随便填一个正数通过校验。
- `name` 是对访客显示的名称，必填且最多 240 字；`version` 可空，最多 100 字；`date` 为有效日历日期或空。
- 附件随草稿保存与发布，顺序由数组决定。未发布或已下架内容的附件不因此变成公开下载；移除引用不执行文件删除。不要向随笔或照片故事提交 `attachments`，即使是空数组。

例如上传返回 `{"url":"/uploads/example-report.pdf","size":12345}` 后，项目的附件片段为：

```json
{
  "attachments": [
    {
      "src": "/uploads/example-report.pdf",
      "name": "项目研究报告",
      "size": 12345,
      "version": "v2",
      "date": "2026-10-11"
    }
  ]
}
```

这是格式示例，`12345` 不能代替你的实际上传字节数。后台照片、正文图片或 PDF 仍在排队、上传失败或等待处理时，必须先完成上传、重试或移除，才能发布。

## 预览、确认与发布

发布前：先 `get`，构造包含真实 ID、最新版本和**明确发布目标**的操作；调用 `preview` 并生成本机 HTML；在聊天给出标题、栏目、改动摘要、影响数量、目标地址和可打开的本机预览。用户明确同意该内容发布到该目标后，才执行 `apply`。

```json
{
  "action": "preview",
  "operations": [
    {
      "action": "publish",
      "kind": "posts",
      "id": "真实ID",
      "expectedVersion": "从get返回的完整version",
      "target": "https://mumao.site/?post=真实ID"
    }
  ]
}
```

运行时添加 `--preview-dir .qa/admin-previews`。结果中的 `localPreview.path` 是可打开的本机 HTML。预览页面显示候选内容，折叠区显示目前正式内容，图片使用现有 Workbench 连接读取，不把私有草稿媒体变成公网链接。外部图片只显示可点击链接，不静默下载；PDF 保存在本地且只作为附件链接。问卷为静态题目与规则展示，不能提交答卷。此页用于内容核对，正式页面沿用网站排版。

v1.2.0 的照片故事预览先显示**公开投影**：城市档位只显示代表点，隐藏档位不显示地图坐标；其后的「后台私有拍摄资料」折叠区专供本人核对原始位置与照片 GPS，不会进入公开阅读页。折叠并不等于从 HTML 删除：本机预览文件仍包含私有资料，不能把整份 HTML 作为公开文章上传或分享。

预览返回 `preview.token`、`preview.expiresAt`、`preview.impactCount` 与 `preview.items`。令牌与同一组操作、内容版本、目标绑定，有效期 30 分钟。原后台或其他助手在此后更改了相关内容，执行会拒绝，必须重新预览。生成本机预览失败时不得据此确认发布。

令牌还绑定预览时的**上海日历日期**。即使 30 分钟尚未到期，只要跨过北京时间午夜，仍须重新预览并核对新的日期后再确认，避免首次发布日期与用户看到的预览不一致。不要自动跳过此错误重新发布。

用户确认后，保持 `operations` 完全相同，添加预览返回值：

```json
{
  "action": "apply",
  "requestId": "830a5bc6-0bda-4663-89ee-a8b95a08c4eb",
  "previewToken": "刚才preview.token的完整值",
  "previewExpiresAt": "刚才preview.expiresAt的原值",
  "approved": true,
  "operations": [
    {
      "action": "publish",
      "kind": "posts",
      "id": "真实ID",
      "expectedVersion": "与预览相同的完整version",
      "target": "https://mumao.site/?post=真实ID"
    }
  ]
}
```

成功后返回 `results`，发布项包含实际 `url`；将其返回用户。不得仅凭预览地址声称已经发布。

目标固定来自读取结果的 `target`，包括 `?post=ID`、`?project=ID`、`?story=ID`、`?survey=ID`；资料目标是 `https://mumao.site/?page=about`。不可发布到任意网址或另一个站点。

下架使用相同流程，将操作改为 `unpublish`；必须预览并获明确确认。个人资料不支持 `unpublish`。问卷下架不删除历史答卷；内容中的 `closed` 可以关闭接收新答卷，发布时应同时核对该标志和起止时间。

## 批量操作与重复提交

每批最多 20 项。多项操作必须先生成同一批的预览，向用户逐项展示变更和总影响数量，确认后用相同操作、预览令牌和 `approved: true` 执行。不要在确认后追加条目。任何一项校验失败、版本冲突或数据库写入失败，整批回滚。

`requestId` 相同且请求相同会返回原结果，`replayed: true`，不会重复建文章或重复发布；同一 ID 用于不同请求会拒绝。遇到传输超时、`outcomeUnknown: true` 或响应丢失，先保留原请求，重试同一 `requestId`，不要另起请求或推断失败。预览和媒体读取不发布内容。

## 图片与 PDF

上传沿用网站媒体处理：JPG、PNG、WebP、GIF 经解析重新编码、去除元数据；PDF 校验文件头。每文件最多 15MiB、每次 1 至 20 个文件；为避免小内存服务器处理大 JSON，助手每次上传总量最多 30MiB，超过时分批。暂不支持视频。

本机请求可以直接指定文件路径，路径相对于请求文件所在目录解析：

```json
{
  "action": "media-upload",
  "requestId": "a0a52e60-af20-40ca-8910-2d2240083778",
  "files": [
    { "path": "images/photo.png", "name": "photo.png" },
    { "path": "attachments/report.pdf" }
  ]
}
```

包装脚本读入这些文件，转换为服务端 `files: [{name, base64}]`，不会把本机路径拼入远程命令。上传本身不使文件公开；只有发布的内容引用它时才通过网站公开访问。保留相同上传 `requestId` 可避免响应丢失后重复上传。

受限读取 `{"action":"media-get","names":["实际上传文件名.png"]}` 仅接受上传目录中的合法文件名，不允许路径或任意系统文件。它会返回媒体 base64；一般无需手动调用或把 base64 输出到聊天。生成本机预览会仅提取候选和正式内容所引用的文件，并逐个读取，以控制服务器内存峰值。

本机单次预览最多 200 个文件、合计 300MiB；超限应缩小预览批次，不跳过必要图片后声称完成核对。预览使用 `script-src 'none'`、`form-action 'none'`、`connect-src 'none'`，正文转义且不执行脚本；主动点击外部链接或 PDF 则会打开相应目标。

## 验证、停用与恢复

隔离测试：

```powershell
node --test tests/admin-cli.test.js tests/admin-content.test.js tests/admin-media.test.js tests/admin-wrapper.test.js tests/essay-drafts-cli.test.js
npm test
```

这些测试模拟 Workbench 文件传输，覆盖命令与路径注入、退出状态与超时、清理、上传格式、预览私有媒体、HTML 转义、外部图片不请求、资料/矩阵问卷展示和失败后的本机清理。它们不能替代真实 Workbench 连接验收。服务器事务、版本冲突、并发、回滚和重试由对应服务测试验证；实际测试及生产只读验收结果记录在本次发布说明。

2026-10-13 本地验证：Node 全量 **177/177**、Python **60/60**、彗星轨道 **20/20** 通过，本机生产构建通过。真实浏览器检查了本机预览的新旧正文对照、图片加载与环绕、资料栏目和矩阵题；390px 手机宽度下图片上下排列且页面无横向溢出。媒体测试含 15MiB 文件完整往返、回执失败回滚以及中断后同请求恢复。生产写入、真实用户内容发布和摄像头/通知不作为本次验收操作；Linux及线上检查以最终 Release 记录为准。

生产验收只使用列表、读取、预览或已有媒体读取，不新增或发布测试内容，也不修改真实资料、问卷和答卷。不能把 mock 传输成功写成生产写入已验证。

停止委托即可停用助手流程。通过正常发布移除脚本可关闭此入口；这不撤销 Workbench 原有运维访问。备份、部署、回滚遵循[版本发布流程](releases.md)和[部署说明](../deploy/README.md)。前端只在本机构建，部署保留数据库和上传文件；回滚应用时不要覆盖发布后新增的内容数据。本版没有新增凭据需要吊销。
