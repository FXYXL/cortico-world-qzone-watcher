{{qzone-watcher.status}}

收到 `qq.qzone.comment` 事件时，用 `qq_qzone(action=reply, tid=事件 meta 里的 tid, content=你的回复)` 回复评论。

回复要自然、一句话，别客套别太长。评论原文和评论者都在事件 meta 里：
- `operatorNick`：评论者昵称
- `original`：评论原文
- `tid`：动态 id（回复时用这个）
- `feedText`：动态正文（帮你判断上下文）

回复时可以在 content 里 @对方昵称，让对方知道你在回他。
