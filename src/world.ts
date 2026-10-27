/**
 * QQ 空间评论监听 World。
 *
 * 它不连 OneBot WebSocket，不提供工具——它只做一件事：
 * 定时用 HTTP 调 SnowLuma 的 qzone API 轮询新评论，发现新评论就推事件给主模型。
 *
 * 主模型收到事件后，用 qq-final 的 qq_qzone(action=reply) 工具回复。
 * 这样回复内容由主模型决定，语气和人格一致。
 *
 * 状态管理：
 * - qzone-watcher-state.json：记录已通知过的 commentId + 每日计数 + 冷却时间
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Language,
  ToolDef,
  World,
  WorldHost,
  WorldLamp,
  WorldWebUiDecl,
  PromptDocDecl,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { QzoneWatcherConfig } from './config.ts';
import { QZONE_WATCHER_CONFIG_GROUP } from './config.ts';
import { QzonePoller, type NewComment } from './qzone-poller.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

interface WatcherState {
  /** 已通知过的 commentId 集合（存在文件里，重启不丢）。 */
  seenComments: string[];
  /** 当天日期（YYYY-MM-DD），用于每日计数重置。 */
  day: string;
  /** 当天已推送数。 */
  dailyCount: number;
  /** 上次推送的时间戳（毫秒）。 */
  lastNotifyAt: number;
}

export interface QzoneWatcherWorldOptions {
  cfg: QzoneWatcherConfig;
  timezone: string;
  dataDir: string;
}

export class QzoneWatcherWorld implements World {
  readonly id = 'qzone-watcher';
  private host: WorldHost | null = null;
  private cfg: QzoneWatcherConfig;
  private readonly timezone: string;
  private readonly dataDir: string;
  private state: WatcherState;
  private poller: QzonePoller | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** 上次轮询时间戳（毫秒），用于控制台显示。 */
  private lastPollAt: number = 0;
  /** 上次轮询结果：'ok' | 'error' | null（还没跑过）。 */
  private lastPollResult: 'ok' | 'error' | null = null;
  /** 上次轮询的错误信息（如果有）。 */
  private lastPollError: string = '';
  /** 上次轮询发现的新评论数。 */
  private lastNewCount: number = 0;

  constructor(opts: QzoneWatcherWorldOptions) {
    this.cfg = opts.cfg;
    this.timezone = opts.timezone;
    this.dataDir = opts.dataDir;
    this.state = this.loadState();
  }

  // ── World 接口 ────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> | null {
    if (!this.cfg.enabled) return null;
    const status = this.timer ? '运行中' : '已停止';
    return {
      'qzone-watcher.status': `QQ空间评论监听：${status}，每 ${this.cfg.pollIntervalSec} 秒轮询一次，今日已推送 ${this.state.dailyCount} 条。`,
    };
  }

  tools(): ToolDef[] {
    // 这个 World 不提供工具——回复靠 qq-final 的 qq_qzone。
    return [];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const lamps: WorldLamp[] = [
      {
        label: '监听状态',
        state: this.cfg.enabled ? (this.timer ? 'online' : 'loading') : 'offline',
        hint: this.cfg.enabled
          ? (this.timer ? '运行中' : '正在启动')
          : '未启用',
      },
      {
        label: 'API 连接',
        state: this.lastPollResult === 'ok' ? 'online' : this.lastPollResult === 'error' ? 'offline' : 'loading',
        hint: this.lastPollResult === 'ok'
          ? 'SnowLuma HTTP 正常'
          : this.lastPollResult === 'error'
            ? `连接失败：${this.lastPollError}`
            : '尚未轮询',
      },
    ];

    // 不定义自定义 panels——那些需要前端构建产物（dist/console.js）。
    // 配置表单由 Cortico Core 根据 config ConfigGroup 自动生成，不需要构建产物。
    // 运行状态通过 lamps + badges 展示。
    return {
      label: 'QQ空间评论监听',
      lamps,
      badges: [
        { label: '今日推送', value: this.state.dailyCount, tone: 'on' },
        { label: '已记录评论', value: this.state.seenComments.length, tone: 'plain' },
        { label: '轮询间隔', value: `${this.cfg.pollIntervalSec}秒`, tone: 'plain' },
        { label: '每次检查', value: `${this.cfg.feedsPerPoll}条动态`, tone: 'plain' },
      ],
      promptDocs: [
        {
          key: 'worlds.qzone-watcher.envPrompt',
          title: 'QQ空间评论监听 · 环境提示词',
          description: '注入 system 前缀：监听状态与回复指引。',
          role: 'envPrompt',
          path: ENV_PROMPT_FILE,
          vars: [
            { name: 'qzone-watcher.status', description: '监听运行状态与今日推送数。' },
          ],
        },
      ],
      config: [QZONE_WATCHER_CONFIG_GROUP],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    if (!this.cfg.enabled) {
      host.log.info('disabled, skipping');
      return;
    }
    if (!this.cfg.httpUrl) {
      host.log.warn('httpUrl 未配置，无法轮询');
      return;
    }

    this.poller = new QzonePoller({
      httpUrl: this.cfg.httpUrl,
      token: this.cfg.token,
      feedsPerPoll: this.cfg.feedsPerPoll,
      log: host.log,
    });

    const sec = Math.max(60, this.cfg.pollIntervalSec);
    this.timer = setInterval(() => {
      this.poll().catch((e) => host.log.error('poll error', e));
    }, sec * 1000);

    host.log.info('started', { pollIntervalSec: sec, httpUrl: this.cfg.httpUrl });

    // 启动后立即跑一次，不等第一个 interval
    this.poll().catch((e) => host.log.error('initial poll error', e));
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.host?.log.info('stopped');
  }

  // ── 轮询 ──────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.polling) return; // 上一次还没跑完，跳过
    if (!this.poller || !this.host) return;
    this.polling = true;
    try {
      const feeds = await this.poller.getFeeds();
      this.lastPollAt = Date.now();
      this.lastPollResult = 'ok';
      this.lastPollError = '';

      if (!feeds.length) {
        this.lastNewCount = 0;
        return;
      }

      // 收集所有新评论
      const newComments: NewComment[] = [];
      for (const feed of feeds) {
        try {
          const comments = await this.poller.getComments(feed.tid, feed.uin);
          for (const c of comments) {
            if (this.isNewComment(c.commentId, feed.tid)) {
              newComments.push({
                ...c,
                feedTid: feed.tid,
                feedText: feed.text,
                feedUin: feed.uin,
                feedNickname: feed.nickname,
              });
            }
          }
        } catch (e) {
          // 单条动态解析失败不影响其他
          this.host.log.warn(`getComments failed for tid=${feed.tid}`, e);
        }
      }

      this.lastNewCount = newComments.length;

      if (!newComments.length) return;

      // 按时间排序，旧的先推
      newComments.sort((a, b) => a.time - b.time);

      // 逐条推送（受冷却和每日上限约束）
      for (const c of newComments) {
        if (!this.canNotify()) break;
        this.notifyComment(c);
      }
    } catch (e) {
      this.lastPollAt = Date.now();
      this.lastPollResult = 'error';
      this.lastPollError = e instanceof Error ? e.message : String(e);
      this.host.log.error('poll failed', e);
    } finally {
      this.polling = false;
    }
  }

  // ── 推送 ──────────────────────────────────────────────────────────────

  private isNewComment(commentId: string, tid: string): boolean {
    // 用 tid:commentId 作为去重 key，因为不同动态下的 comment_id 可能重复（都是简单数字）
    const key = `${tid}:${commentId}`;
    return !this.state.seenComments.includes(key);
  }

  private canNotify(): boolean {
    this.rolloverDay();
    // 静默时段
    if (this.inQuietHours()) return false;
    // 每日上限
    if (this.cfg.dailyNotifyLimit > 0 && this.state.dailyCount >= this.cfg.dailyNotifyLimit) return false;
    // 冷却
    const now = Date.now();
    if (now - this.state.lastNotifyAt < this.cfg.notifyCooldownSec * 1000) return false;
    return true;
  }

  private notifyComment(c: NewComment): void {
    if (!this.host) return;
    this.state.lastNotifyAt = Date.now();
    this.state.dailyCount += 1;
    this.markSeen(c.commentId, c.feedTid);
    this.saveState();

    // 推事件给主模型。origin=external：评论来自任意评论者，是不可信外部内容。
    const feedPreview = c.feedText.slice(0, 80);
    const text = `QQ空间评论：${c.name ? c.name + ' ' : ''}在你的动态下评论了「${c.content}」。动态内容：「${feedPreview}」。用 qq_qzone(action=reply) 回复。`;

    void this.host.pushEvent({
      type: 'qq.qzone.comment',
      senderKey: `qzone:${c.feedTid}`,
      text,
      meta: {
        conv: `qzone:${c.feedTid}`,
        tid: c.feedTid,
        commentId: c.commentId,
        operatorNick: c.name,
        operatorUin: c.uin,
        original: c.content,
        feedText: c.feedText.slice(0, 200),
      },
    });

    this.host.log.info('notified comment', { tid: c.feedTid, commentId: c.commentId, name: c.name });
  }

  // ── 时间工具 ──────────────────────────────────────────────────────────

  private rolloverDay(): void {
    const today = nowIso(this.timezone).slice(0, 10);
    if (this.state.day !== today) {
      this.state.day = today;
      this.state.dailyCount = 0;
      // 清理 seenComments：只保留最近 500 条，防止无限增长
      if (this.state.seenComments.length > 500) {
        this.state.seenComments = this.state.seenComments.slice(-500);
      }
      this.saveState();
    }
  }

  private inQuietHours(): boolean {
    const h = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: this.timezone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date()),
    );
    const { quietFrom, quietTo } = this.cfg;
    return quietFrom > quietTo ? (h >= quietFrom || h < quietTo) : (h >= quietFrom && h < quietTo);
  }

  // ── 持久化 ────────────────────────────────────────────────────────────

  private get stateFile(): string {
    return join(this.dataDir, 'qzone-watcher-state.json');
  }

  private loadState(): WatcherState {
    try {
      if (existsSync(this.stateFile)) {
        const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<WatcherState>;
        return {
          seenComments: Array.isArray(raw.seenComments) ? raw.seenComments : [],
          day: typeof raw.day === 'string' ? raw.day : '',
          dailyCount: typeof raw.dailyCount === 'number' ? raw.dailyCount : 0,
          lastNotifyAt: typeof raw.lastNotifyAt === 'number' ? raw.lastNotifyAt : 0,
        };
      }
    } catch {
      // 加载失败不阻断启动，用空状态
    }
    return { seenComments: [], day: '', dailyCount: 0, lastNotifyAt: 0 };
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(this.state), 'utf8');
    } catch (e) {
      this.host?.log.warn('save state failed', e);
    }
  }

  private markSeen(commentId: string, tid: string): void {
    const key = `${tid}:${commentId}`;
    if (!this.state.seenComments.includes(key)) {
      this.state.seenComments.push(key);
    }
  }
}
