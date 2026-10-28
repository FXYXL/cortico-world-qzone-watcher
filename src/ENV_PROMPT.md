{{qzone-watcher.status}}

收到 `qq.qzone.comment` 事件时，事件里可能包含**多条新评论**（meta.comments 数组）。

逐条处理：
- 对每条评论，用 `qq_qzone(action=reply, tid=该条的tid, content=你的回复)` 回复
- 回复要自然、一句话，别客套别太长
- 不同评论可以分别回复，不要合并成一条（QQ 空间的回复是对动态发评论，不是对评论回复）
- 回复时可以在 content 里 @对方昵称，让对方知道你在回他

每条评论的 meta 结构：
- `tid`：动态 id（回复时用这个）
- `commentId`：评论 id
- `operatorNick`：评论者昵称
- `operatorUin`：评论者 QQ 号
- `original`：评论原文
- `feedText`：动态正文（帮你判断上下文）
- `parentCommentId`：父评论 id（空字符串=顶级评论，非空=楼中楼回复）
- `isReply`：是否为楼中楼回复（true=回复了某条评论，false=直接评论动态）

楼中楼回复（isReply=true）表示对方在你的评论下面回复了你，同样需要回复。
