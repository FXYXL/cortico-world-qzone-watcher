/**
 * QQ 空间评论监听器的配置段：worlds.qzone-watcher
 *
 * 这个 World 不连 OneBot WebSocket——它只是一个 HTTP 客户端，定时调
 * SnowLuma 的 qzone API 轮询新评论。所以它需要一个 HTTP 端点地址和 token，
 * 这些通常跟 qq-final 用的是同一个 SnowLuma 实例。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface QzoneWatcherConfig {
  enabled: boolean;
  /** SnowLuma/NapCat 的 HTTP 端点（含协议和端口）。跟 qq-final 连的是同一个实例。 */
  httpUrl: string;
  /** HTTP 端点的 access token（SnowLuma 配置里的 accessToken）。 */
  token: string;
  /** 轮询间隔（秒）。太短会增加 SnowLuma 负担，太长评论回复慢。默认 180（3 分钟）。 */
  pollIntervalSec: number;
  /** 每次轮询拉几条动态来检查评论。默认 5。 */
  feedsPerPoll: number;
  /** 每日推送上限（防止刷屏）。0=不限。默认 20。 */
  dailyNotifyLimit: number;
  /** 每次推送最多包含几条评论。超出的留到下次推送；如果对应动态已滚出 feeds 就自然丢弃。默认 5。 */
  maxRepliesPerPush: number;
  /** 两次推送之间最少隔多久（秒），避免一条动态下连续多条评论触发多次。默认 60。 */
  notifyCooldownSec: number;
  /** 静默时段：这个时间段内不推送评论通知（不影响轮询和去重）。默认 23~9。 */
  quietFrom: number;
  quietTo: number;
}

export const QZONE_WATCHER_DEFAULTS: QzoneWatcherConfig = {
  enabled: false,
  httpUrl: 'http://127.0.0.1:3002',
  token: '',
  pollIntervalSec: 180,
  feedsPerPoll: 5,
  dailyNotifyLimit: 20,
  maxRepliesPerPush: 5,
  notifyCooldownSec: 60,
  quietFrom: 23,
  quietTo: 9,
};

export const QZONE_WATCHER_CONFIG_GROUP: ConfigGroup = {
  id: 'world:qzone-watcher',
  owner: 'world:qzone-watcher',
  schema: {
    type: 'object',
    title: 'QQ空间评论监听',
    description: '定时轮询 SnowLuma 的 qzone API，发现新评论后推事件给主模型，配合 qq-final 回复。',
    properties: {
      'worlds.qzone-watcher.enabled': {
        type: 'boolean',
        title: '启用',
        'x-hot': false,
        description: '开启后定时轮询 QQ 空间评论。需重启生效。',
      },
      'worlds.qzone-watcher.httpUrl': {
        type: 'string',
        title: 'SnowLuma HTTP 端点',
        'x-hot': false,
        description: 'SnowLuma/NapCat 的 HTTP 地址（如 http://127.0.0.1:3002）。跟 qq-final 连的是同一个实例。改动重启生效。',
      },
      'worlds.qzone-watcher.token': {
        type: 'string',
        title: 'HTTP Access Token',
        'x-hot': false,
        description: 'SnowLuma 配置里的 accessToken。留空则不带鉴权头（仅本机无 token 时可用）。改动重启生效。',
      },
      'worlds.qzone-watcher.pollIntervalSec': {
        type: 'integer',
        title: '轮询间隔（秒）',
        minimum: 60,
        maximum: 3600,
        'x-suffix': '秒',
        'x-hot': true,
        description: '多久检查一次新评论。默认 180 秒（3 分钟）。',
      },
      'worlds.qzone-watcher.feedsPerPoll': {
        type: 'integer',
        title: '每次检查动态数',
        minimum: 1,
        maximum: 20,
        'x-suffix': '条',
        'x-hot': true,
        description: '每次轮询拉几条动态来检查评论。默认 5。',
      },
      'worlds.qzone-watcher.dailyNotifyLimit': {
        type: 'integer',
        title: '每日推送上限',
        minimum: 0,
        maximum: 100,
        'x-suffix': '条',
        'x-hot': true,
        description: '一天最多推送几批评论通知，防止刷屏。0=不限。默认 20。',
      },
      'worlds.qzone-watcher.maxRepliesPerPush': {
        type: 'integer',
        title: '每次推送评论数',
        minimum: 1,
        maximum: 50,
        'x-suffix': '条',
        'x-hot': true,
        description: '一次推送最多包含几条评论。超出的留到下次；如果对应动态已滚出拉取范围就自然丢弃。默认 5。',
      },
      'worlds.qzone-watcher.notifyCooldownSec': {
        type: 'integer',
        title: '推送冷却（秒）',
        minimum: 0,
        maximum: 3600,
        'x-suffix': '秒',
        'x-hot': true,
        description: '两次推送之间最少隔多久。默认 60 秒。',
      },
      'worlds.qzone-watcher.quietFrom': {
        type: 'integer',
        title: '静默开始（点）',
        minimum: 0,
        maximum: 23,
        'x-suffix': '时',
        'x-hot': true,
        description: '这个时间段内不推送评论通知（不影响轮询和去重）。默认 23 点。',
      },
      'worlds.qzone-watcher.quietTo': {
        type: 'integer',
        title: '静默结束（点）',
        minimum: 0,
        maximum: 23,
        'x-suffix': '时',
        'x-hot': true,
        description: '静默结束时间。默认 9 点。',
      },
    },
  },
};
