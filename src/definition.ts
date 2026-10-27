/**
 * World 定义：把 World 类、配置默认值和自描述绑在一起，供 Cortico 装配层使用。
 */
import type { EventDescribe } from 'cortico/core/types.ts';
import type { WorldDefinition } from 'cortico/world.ts';
import { QzoneWatcherWorld } from './world.ts';
import { QZONE_WATCHER_DEFAULTS, type QzoneWatcherConfig } from './config.ts';

const EVENTS: EventDescribe[] = [
  {
    type: 'qzone-watcher.started',
    description: {
      zh: 'QQ 空间评论监听已启动，开始定时轮询。',
      en: 'Qzone comment watcher started polling.',
    },
  },
  {
    type: 'qq.qzone.comment',
    description: {
      zh: '你的 QQ 空间动态下有新评论。请用 qq_qzone(action=reply, tid=事件meta里的tid, content=你的回复) 回复。评论原文、评论者、tid 都在事件 meta 里。',
      en: 'A new comment appeared under your Qzone post. Reply with qq_qzone(action=reply, tid=from meta, content=your reply).',
    },
  },
];

export const definition: WorldDefinition<QzoneWatcherConfig> = {
  id: 'qzone-watcher',
  label: 'QQ空间评论监听',
  defaults() {
    return structuredClone(QZONE_WATCHER_DEFAULTS);
  },
  create(ctx) {
    return new QzoneWatcherWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      dataDir: ctx.dataDir,
    });
  },
  describe: {
    tools: [],
    events: EVENTS,
  },
};
