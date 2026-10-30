# cortico-world-qzone-watcher

QQ 空间评论监听 World：定时轮询 SnowLuma 的 qzone API，发现新评论后推事件给主模型，配合 [cortico-world-qq-final](https://github.com/hth768/cortico-world-qq-final#readme) 的 `qq_qzone(action=reply)` 实现评论自动回复。

## 为什么需要这个插件

SnowLuma/NapCat 有 qzone 的 HTTP API（发说说、评论、拉动态），但**不推送 qzone 评论事件**。[cortico-world-qq-final](https://github.com/hth768/cortico-world-qq-final#readme) 的评论自动回复功能等待 `qq.message.comment.new` 事件，但 SnowLuma 永远不会发这个事件——自动回复就失效了。

这个插件填补这个缺口：用**定时轮询**代替事件推送。

## 工作流程

```
每 N 秒定时触发
    │
    ├─ 调 SnowLuma HTTP: get_qzone_feeds → 拉最近 N 条动态
    │
    ├─ 对每条动态调: get_qzone_msg_detail → 拉评论列表
    │    └─ 递归读取 replies（楼中楼回复），展平到统一列表
    │
    ├─ 过滤掉 bot 自己的评论（启动时调 get_login_info 获取 QQ 号）
    │
    ├─ 对比本地 seenComments → 筛出没见过的评论
    │    └─ 去重 key: tid:parentCommentId:commentId
    │       （顶级评论 parentCommentId 为空，楼中楼指向父评论，
    │        避免不同层级 comment_id 相同导致冲突）
    │
    ├─ 按时间排序（最早的在前），取前 maxRepliesPerPush 条
    │    └─ 剩余的不标记 seen，下次轮询还会发现
    │       如果对应动态已滚出 feeds，评论自然消失，不再推送
    │
    ├─ 合并成一条事件 pushEvent
    │    type: qq.qzone.comment
    │    meta.comments: [{ tid, commentId, operatorNick, original,
    │                       feedText, parentCommentId, isReply }, ...]
    │
    └─ 主模型收到事件 → 用 qq_qzone(action=reply) 逐条回复
```

> 配套插件：[cortico-world-qq-final](https://github.com/hth768/cortico-world-qq-final#readme)

## 运行逻辑详解

### 初始化扫描（首次启动）

插件第一次启动时，会拉取当前所有动态的评论，**全部标记为 seen 但不推送**。这样只有之后真正新来的评论才会触发通知——不会把已有的旧评论当新评论推送。

`initialized` 标志持久化到状态文件，重启 Coopanion 不会丢失。如果重启时有未推送的评论（比如达到每日上限积攒的），它们不会被初始化扫描覆盖。

### bot 自己的评论过滤

轮询时如果评论的 `uin` 等于 bot 自己的 QQ 号，直接跳过——避免 bot 回复自己的评论导致无限循环。

bot 的 QQ 号在**每次轮询里惰性获取**（`get_login_info`），成功一次就记住。所以 SnowLuma 晚于插件启动也没关系：连上后自动补到身份，不需要重启插件。

### 连接失败自动恢复

轮询循环在 `start()` 里**立即启动**，不阻塞在任何网络请求上——SnowLuma 没起来时插件照常进入轮询状态，只把「API 连接」灯标红并写明失败原因。

失败后的重试间隔会缩短（15s → 30s → 60s 指数退避，上限受 `pollIntervalSec` 约束），所以 SnowLuma 后启动时，**几十秒内指示灯就会自己转绿**，不必等满一个完整轮询周期。恢复正常后回到 `pollIntervalSec` 的常规节奏。

### 楼中楼回复

评论的回复（楼中楼）嵌套在 SnowLuma 返回数据的 `replies` 字段里。插件递归读取，展平到统一列表，和顶级评论一起处理。事件 meta 里每条评论带 `parentCommentId`（空=顶级评论，非空=楼中楼）和 `isReply` 字段，主模型可以据此区分。

### 多条评论合并推送

一次轮询发现的多条新评论**合并成一条事件**推送，而不是逐条推。主模型收到后分别调 `qq_qzone(action=reply)` 逐条回复。

### 每次推送条数限制

`maxRepliesPerPush` 控制一次推送最多包含几条评论（默认 5）。超出的评论不标记 seen，下次轮询还会发现：

- 如果对应动态还在 feeds 里 → 下次推送（如果 canNotify 通过）
- 如果对应动态滚出 feeds → 评论自然消失，不再推送

### 推送防护

三重机制控制推送频率：

| 机制 | 说明 |
|---|---|
| **每日上限** | `dailyNotifyLimit`（默认 20），一天最多推送 20 批。到上限后不推送，评论保留为 unseen，第二天 `dailyCount` 重置后继续推 |
| **推送冷却** | `notifyCooldownSec`（默认 60 秒），两次推送至少隔 60 秒 |
| **静默时段** | `quietFrom`~`quietTo`（默认 23~9 点），夜间不推送（但仍然轮询和去重） |

### 每日上限与未推送评论

如果达到每日上限但有未推送的评论：
- 这些评论不会被标记 seen，不会被丢失
- 下次轮询还会发现它们
- 到第二天 `rolloverDay()` 重置 `dailyCount` 为 0，`canNotify()` 通过，积攒的评论合并成一条事件推送

## 特性

- **不提供工具**：只推事件，回复内容由主模型决定，语气和人格一致
- **不连 WebSocket**：纯 HTTP 客户端，不占用额外的 OneBot 连接
- **楼中楼支持**：递归读取 replies，顶级评论和回复都能检测到
- **去重持久化**：`tid:parentCommentId:commentId` 复合 key，重启不重复推
- **初始化扫描**：首次启动只标记不推送，避免旧评论被当新评论
- **bot 评论过滤**：自动获取 bot QQ 号，过滤自己的评论防循环
- **条数限制**：每次最多推 N 条，超出的留到下次，动态滚出 feeds 后自然丢弃
- **三重防护**：静默时段、每日上限、推送冷却
- **宽松解析**：SnowLuma 返回字段缺失不抛错，单条动态解析失败不影响其他

## 配置

在控制台的 `worlds.qzone-watcher` 段配置：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 启用开关 |
| `httpUrl` | `http://127.0.0.1:3002` | SnowLuma HTTP 端点（跟 qq-final 连同一个实例） |
| `token` | (空) | SnowLuma HTTP access token |
| `pollIntervalSec` | `180` | 轮询间隔（秒），最小 60 |
| `feedsPerPoll` | `5` | 每次检查几条动态的评论 |
| `dailyNotifyLimit` | `20` | 每日推送上限（防刷屏），0=不限 |
| `maxRepliesPerPush` | `5` | 每次推送最多包含几条评论，超出的留到下次 |
| `notifyCooldownSec` | `60` | 两次推送最少间隔（秒） |
| `quietFrom` | `23` | 静默开始（24小时制，此时间后不推） |
| `quietTo` | `9` | 静默结束（此时间前不推） |

### 如何获取 token

打开 SnowLuma 配置目录 `config/onebot_<QQ号>.json`，找到 `httpServers` 段里的 `accessToken` 字段，复制到插件配置的 `token` 里。

## 依赖与适配版本

| 依赖 | 版本 | 说明 |
|---|---|---|
| [cortico-world-qq-final](https://github.com/hth768/cortico-world-qq-final#readme) | ≥ 0.6.x | 提供 `qq_qzone(action=reply)` 工具，主模型用它回复评论 |
| SnowLuma | ≥ 1.14.x | 提供 `get_qzone_feeds` 和 `get_qzone_msg_detail` HTTP API |
| Cortico Core | World API 6 | Cortico 0.2.7+ 的 World 装配契约 |

> 本插件开发时参考的版本：cortico-world-qq-final 0.6.35、SnowLuma 1.14.22。其他版本未逐一测试，API 字段名如有差异可能需要微调 `qzone-poller.ts` 里的解析逻辑。

## 安装

### 本地安装

```bash
cd <Coopanion>/data/extensions
pnpm add cortico-world-qzone-watcher
```

或手动复制到 `node_modules/` 并在 `package.json` 的 `dependencies` 里添加：

```json
"cortico-world-qzone-watcher": "0.1.0"
```

### 从 npm 安装

```bash
pnpm add cortico-world-qzone-watcher
```

安装后在控制台的「Worlds」页面启用 `qzone-watcher`。

## 文件结构

```
cortico-world-qzone-watcher/
├── package.json          # npm 包定义
├── describe.json         # 事件声明（给市场和控制台看）
├── README.md
├── LICENSE
└── src/
    ├── index.ts          # 入口，导出 definition
    ├── definition.ts     # WorldDefinition
    ├── config.ts         # 配置段定义
    ├── qzone-poller.ts   # HTTP 轮询器：调 SnowLuma API、解析返回、递归 replies
    ├── world.ts          # World 类：定时器、去重、冷却、推事件、控制台 UI
    └── ENV_PROMPT.md     # 环境提示词模板
```

## 控制台 UI

插件页面由 Cortico Core 根据 `config`（ConfigGroup）自动生成配置表单，不需要前端构建产物。

**状态灯（lamps）：**
- **监听状态**：运行中 / 正在启动 / 未启用
- **API 连接**：SnowLuma HTTP 正常 / 连接失败（红，带重试倒计时）/ 尚未轮询

**徽章（badges）：**
- 连接（正常 / 断开重试中 / 等待首次轮询）、轮询间隔、每次检查动态数、每日上限、静默时段

**数据页（storage，实时状态）：**
- 今日推送数、已记录评论数、上次轮询时间和结果、下次重试倒计时、bot 身份是否取得
- 支持清除操作（清空状态后重新初始化扫描）

**环境提示词面板：**
- 由 Core 自动渲染，包含 `qzone-watcher.status` 变量

## 状态文件

插件在 `dataDir` 下维护一个 `qzone-watcher-state.json`：

```json
{
  "seenComments": ["tid::commentId", "tid:parentCommentId:commentId", ...],
  "day": "2026-10-28",
  "dailyCount": 3,
  "lastNotifyAt": 1730083200000,
  "initialized": true
}
```

- `seenComments`：去重 key 列表（`tid:parentCommentId:commentId`），超过 500 条自动裁剪
- `initialized`：是否完成初始化扫描（持久化，重启不丢）
- 跨天时自动重置 `dailyCount`
- 可在控制台数据页清除（清除后重新初始化扫描）

## License

MIT
