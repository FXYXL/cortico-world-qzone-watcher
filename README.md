# cortico-world-qzone-watcher

QQ 空间评论监听 World：定时轮询 SnowLuma 的 qzone API，发现新评论后推事件给主模型，配合 `cortico-world-qq-final` 的 `qq_qzone(action=reply)` 实现评论自动回复。

## 为什么需要这个插件

SnowLuma/NapCat 有 qzone 的 HTTP API（发说说、评论、拉动态），但**不推送 qzone 评论事件**。`cortico-world-qq-final` 的评论自动回复功能等待 `qq.message.comment.new` 事件，但 SnowLuma 永远不会发这个事件——自动回复就失效了。

这个插件填补这个缺口：用**定时轮询**代替事件推送。

## 工作流程

```
每 N 秒定时触发
    │
    ├─ 调 SnowLuma HTTP: get_qzone_feeds → 拉最近 N 条动态
    │
    ├─ 对每条动态调: get_qzone_msg_detail → 拉评论列表
    │
    ├─ 对比本地 seen-comments → 筛出没见过的 commentId
    │
    ├─ 有新评论 → host.pushEvent() 推事件给主模型
    │     事件 type: qq.qzone.comment
    │     meta 里带: tid, commentId, 评论者昵称, 评论原文, 动态正文
    │
    └─ 主模型收到事件 → 用 qq-final 的 qq_qzone(action=reply) 回复
```

## 特性

- **不提供工具**：只推事件，回复内容由主模型决定，语气和人格一致
- **不连 WebSocket**：纯 HTTP 客户端，不占用额外的 OneBot 连接
- **去重持久化**：已通知过的 commentId 存在本地文件，重启不重复推
- **三重防护**：静默时段（夜间不推）、每日上限、推送冷却
- **控制台 UI**：实时显示轮询状态、API 连接状态、今日推送数等
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
| `notifyCooldownSec` | `60` | 两次推送最少间隔（秒） |
| `quietFrom` | `23` | 静默开始（24小时制，此时间后不推） |
| `quietTo` | `9` | 静默结束（此时间前不推） |

### 如何获取 token

打开 SnowLuma 配置目录 `config/onebot_<QQ号>.json`，找到 `httpServers` 段里的 `accessToken` 字段，复制到插件配置的 `token` 里。

## 依赖

| 依赖 | 说明 |
|---|---|
| `cortico-world-qq-final` | 提供 `qq_qzone(action=reply)` 工具，主模型用它回复评论 |
| SnowLuma / NapCat | 提供 `get_qzone_feeds` 和 `get_qzone_msg_detail` HTTP API |
| Cortico Core | World API 6 |

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
    ├── qzone-poller.ts   # HTTP 轮询器
    ├── world.ts          # World 类：定时器、去重、冷却、推事件、控制台 UI
    └── ENV_PROMPT.md     # 环境提示词模板
```

## 控制台 UI

插件提供两个控制台面板：

- **运行状态**：轮询状态、上次轮询时间/结果、今日推送数、已记录评论数、静默时段
- **配置**：当前所有配置项的快照

顶部状态灯：
- **监听状态**：运行中 / 正在启动 / 未启用
- **API 连接**：SnowLuma HTTP 正常 / 连接失败 / 尚未轮询

## 状态文件

插件在 `dataDir` 下维护一个 `qzone-watcher-state.json`：

```json
{
  "seenComments": ["commentId1", "commentId2", ...],
  "day": "2026-10-28",
  "dailyCount": 3,
  "lastNotifyAt": 1730083200000
}
```

- `seenComments` 超过 500 条时自动裁剪到最近 500 条
- 跨天时自动重置 `dailyCount`

## License

MIT
