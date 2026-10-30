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
  StoragePart,
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
  /** 是否已完成初始化扫描（持久化，重启后不丢）。 */
  initialized: boolean;
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
  /**
   * 下一次轮询的定时器。用自调度 setTimeout 而不是固定 setInterval —— 这样「连接失败」时
   * 可以按短间隔快速重试，而不是干等满一个完整轮询周期（默认 180s）才再试一次。
   */
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  /** bot 自己的 QQ 号，用于过滤自己的评论。 */
  private botUin: string = '';
  /** bot 身份是否已拿到；没拿到就每次轮询都重试，SnowLuma 后启动也能补上。 */
  private identityResolved = false;
  /** 上次轮询时间戳（毫秒），用于控制台显示。 */
  private lastPollAt: number = 0;
  /** 下次轮询的计划时刻（毫秒），用于控制台显示重试倒计时。 */
  private nextPollAt: number = 0;
  /** 上次轮询结果：'ok' | 'error' | null（还没跑过）。 */
  private lastPollResult: 'ok' | 'error' | null = null;
  /** 上次轮询的错误信息（如果有）。 */
  private lastPollError: string = '';
  /** 连续失败次数：为 0 表示上轮成功，用来做断连后的指数退避。 */
  private consecutiveErrors: number = 0;
  /** stop() 后置位，阻止在途轮询再排下一次。 */
  private stopped = false;
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
    const running = !!this.pollTimer || this.polling;
    const status = running ? '运行中' : '已停止';
    const conn = this.lastPollResult === 'ok' ? 'SnowLuma 连接正常'
      : this.lastPollResult === 'error' ? `SnowLuma 连接失败（${this.lastPollError}）`
        : '尚未完成首次轮询';
    return {
      'qzone-watcher.status': `QQ空间评论监听：${status}，${conn}，每 ${this.intervalSec()} 秒轮询一次，今日已推送 ${this.state.dailyCount} 条。`,
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
        state: !this.cfg.enabled ? 'offline'
          : (this.pollTimer || this.polling) ? 'online'
            : 'loading',
        hint: !this.cfg.enabled
          ? '未启用'
          : (this.pollTimer || this.polling)
            ? `运行中，每 ${this.intervalSec()} 秒轮询一次`
            : '正在启动',
      },
      {
        label: 'API 连接',
        state: this.lastPollResult === 'ok' ? 'online'
          : this.lastPollResult === 'error' ? 'error'
            : 'loading',
        hint: this.lastPollResult === 'ok'
          ? `SnowLuma HTTP 正常${this.lastPollAt ? `（上次 ${this.fmtTime(this.lastPollAt)}）` : ''}`
          : this.lastPollResult === 'error'
            ? `连接失败：${this.lastPollError}${this.retryHint()}`
            : '尚未轮询',
      },
    ];

    // badges 在每次 webUi() 调用时重新计算（WebUI 每次请求都会调 webUi），
    // 所以「连接」这一项可以跟着轮询结果变化；更细的运行数据仍在 storage.stat()。
    return {
      label: 'QQ空间评论监听',
      lamps,
      badges: [
        {
          label: '连接',
          value: this.lastPollResult === 'ok' ? '正常'
            : this.lastPollResult === 'error' ? '断开重试中'
              : '等待首次轮询',
          tone: this.lastPollResult === 'ok' ? 'on' : this.lastPollResult === 'error' ? 'off' : 'plain',
        },
        { label: '轮询间隔', value: `${this.intervalSec()}秒`, tone: 'plain' },
        { label: '每次检查', value: `${this.cfg.feedsPerPoll}条动态`, tone: 'plain' },
        { label: '每日上限', value: `${this.cfg.dailyNotifyLimit}条`, tone: 'plain' },
        { label: '静默时段', value: `${this.cfg.quietFrom}:00-${this.cfg.quietTo}:00`, tone: 'plain' },
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
      storage: [
        {
          key: 'qzone-watcher-state',
          label: '监听状态数据',
          kind: 'disk',
          location: join(this.dataDir, 'qzone-watcher-state.json'),
          note: '已通知过的评论 ID 列表和每日计数。清除后下次启动会重新初始化扫描。',
          stat: () => this.storageStat(),
          clear: async () => this.clearState(),
        },
      ],
    };
  }

  /** storage.stat() 的实现：返回实时运行状态。 */
  private storageStat(): string {
    const lastPoll = this.lastPollAt ? this.fmtTime(this.lastPollAt) : '尚未轮询';
    const lastResult = this.lastPollResult === 'ok'
      ? '正常'
      : this.lastPollResult === 'error'
        ? `错误：${this.lastPollError}${this.retryHint()}`
        : '未轮询';
    const identity = this.identityResolved ? `bot=${this.botUin}` : 'bot 身份未取得（每次轮询重试）';
    return `今日推送 ${this.state.dailyCount}/${this.cfg.dailyNotifyLimit}，已记录评论 ${this.state.seenComments.length} 条，`
      + `上次轮询：${lastPoll}（${lastResult}），${identity}`;
  }

  /** storage.clear() 的实现：清空状态文件。 */
  private async clearState(): Promise<string> {
    this.state = { seenComments: [], day: '', dailyCount: 0, lastNotifyAt: 0, initialized: false };
    this.saveState();
    return '已清空监听状态。下次轮询将重新初始化扫描。';
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopped = false;
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

    // 关键：这里**不能**先 await 任何网络请求再建定时器。
    // 旧实现是先 await getLoginInfo() 才 setInterval —— SnowLuma 没起来时这一步失败（或卡在
    // 超时上），轮询循环就迟迟建不起来；之后 SnowLuma 开好了也没有人再去连，指示灯因此一直红着。
    // 现在：定时器立即生效；bot 身份改在每次轮询里惰性获取，成功一次就记住。
    host.log.info('started', { pollIntervalSec: this.intervalSec(), httpUrl: this.cfg.httpUrl });

    // 启动后立即跑一次，不等第一个间隔
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.host?.log.info('stopped');
  }

  // ── 轮询调度 ──────────────────────────────────────────────────────────

  /** 正常轮询间隔（秒），下限 60。 */
  private intervalSec(): number {
    return Math.max(60, this.cfg.pollIntervalSec);
  }

  /**
   * 下一次轮询的延迟：成功时按配置间隔；失败时快速重试。
   * 连接被拒是本机调用，非常便宜，所以断连时用 15s 起、指数退避到最多 60s，
   * 这样 SnowLuma 后启动时，指示灯几十秒内就能自己转绿，而不必等满一个 180s 周期。
   */
  private retryDelayMs(): number {
    const base = this.intervalSec() * 1000;
    if (this.lastPollResult === 'ok') return base;
    const exp = Math.max(0, Math.min(this.consecutiveErrors - 1, 2));
    return Math.min(base, 15000 * 2 ** exp);
  }

  /** 排下一次轮询（自调度，替代固定 setInterval）。 */
  private scheduleNext(delayMs: number): void {
    if (this.stopped || !this.host) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const delay = Math.max(0, delayMs);
    this.nextPollAt = Date.now() + delay;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll().catch((e) => this.host?.log.error('poll error', e));
    }, delay);
    this.pollTimer.unref?.();
  }

  /** 控制台显示用的本地时间。 */
  private fmtTime(ts: number): string {
    try {
      return new Date(ts).toLocaleString('zh-CN', { timeZone: this.timezone });
    } catch {
      return new Date(ts).toLocaleString('zh-CN');
    }
  }

  /** 连接失败时给指示灯的补充说明（含重试倒计时）。 */
  private retryHint(): string {
    if (!this.nextPollAt) return '';
    const sec = Math.max(1, Math.round((this.nextPollAt - Date.now()) / 1000));
    return `；约 ${sec} 秒后自动重试`;
  }

  // ── 轮询 ──────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.polling) return; // 上一次还没跑完，跳过
    if (!this.poller || !this.host) return;
    const host = this.host;
    const poller = this.poller;
    this.polling = true;
    try {
      // bot 身份惰性获取：只成功一次就记住，失败不阻断本次轮询，下次再试。
      // 这样 SnowLuma 后启动时也能补上身份，不会永远过滤不了自己的评论。
      if (!this.identityResolved) {
        try {
          const info = await poller.getLoginInfo();
          if (info.uin) {
            this.botUin = info.uin;
            this.identityResolved = true;
            host.log.info('bot identity', { uin: info.uin, nickname: info.nickname });
          }
        } catch (e) {
          host.log.debug(`获取 bot QQ 号失败，下次轮询重试：${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const feeds = await poller.getFeeds();
      this.lastPollAt = Date.now();
      this.lastPollResult = 'ok';
      this.lastPollError = '';

      if (!feeds.length) {
        this.lastNewCount = 0;
        return;
      }

      // 收集所有评论
      const allComments: NewComment[] = [];
      for (const feed of feeds) {
        try {
          const comments = await this.poller.getComments(feed.tid, feed.uin);
          for (const c of comments) {
            // 过滤 bot 自己的评论，避免无限循环
            if (this.botUin && c.uin === this.botUin) continue;
            allComments.push({
              ...c,
              feedTid: feed.tid,
              feedText: feed.text,
              feedUin: feed.uin,
              feedNickname: feed.nickname,
            });
          }
        } catch (e) {
          // 单条动态解析失败不影响其他
          this.host.log.warn(`getComments failed for tid=${feed.tid}`, e);
        }
      }

      // 第一次启动（初始化扫描）：把所有已有评论标记为 seen，但不推送。
      // 这样只有之后真正新来的评论才会触发通知。
      if (!this.state.initialized) {
        for (const c of allComments) {
          this.markSeen(c.commentId, c.feedTid, c.parentCommentId);
        }
        this.state.initialized = true;
        this.saveState();
        this.lastNewCount = 0;
        this.host.log.info('initial scan done', { seenComments: this.state.seenComments.length });
        return;
      }

      // 筛出未见过的新评论
      const newComments = allComments.filter((c) => this.isNewComment(c.commentId, c.feedTid, c.parentCommentId));
      this.lastNewCount = newComments.length;

      if (!newComments.length) return;

      // 按时间排序，旧的在前
      newComments.sort((a, b) => a.time - b.time);

      // 只推送前 N 条（maxRepliesPerPush），剩余的不标记 seen，下次轮询还会发现。
      // 如果那些评论对应的动态已经滚出 feeds（不再被拉取到），它们就自然消失——不会再被推送。
      const max = Math.max(1, this.cfg.maxRepliesPerPush);
      const toPush = newComments.slice(0, max);
      const deferred = newComments.length - toPush.length;

      // 合并推送
      if (!this.canNotify()) return;
      this.notifyComments(toPush, deferred);
    } catch (e) {
      this.lastPollAt = Date.now();
      this.lastPollResult = 'error';
      this.lastPollError = e instanceof Error ? e.message : String(e);
      this.host.log.error('poll failed', e);
    } finally {
      this.polling = false;
      // 结果决定下一次的间隔：成功走正常周期，失败走快速重试（见 retryDelayMs）。
      this.consecutiveErrors = this.lastPollResult === 'ok' ? 0 : this.consecutiveErrors + 1;
      this.scheduleNext(this.retryDelayMs());
    }
  }

  // ── 推送 ──────────────────────────────────────────────────────────────

  private isNewComment(commentId: string, tid: string, parentCommentId: string): boolean {
    // 去重 key：tid + parentCommentId + commentId
    // 顶级评论的 parentCommentId 为空，楼中楼回复的 parentCommentId 指向父评论。
    // 不加 parentCommentId 的话，楼中楼的 comment_id 可能和顶级评论重复。
    const key = `${tid}:${parentCommentId}:${commentId}`;
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

  /**
   * 合并推送多条新评论：一条事件带上所有评论，主模型逐条回复。
   * 只推送传入的这些（已经被 maxRepliesPerPush 截断），剩余的 deferred 条不标记 seen，
   * 下次轮询还会发现；如果对应动态已滚出 feeds，它们就自然消失。
   */
  private notifyComments(comments: NewComment[], deferred: number): void {
    if (!this.host || !comments.length) return;
    this.state.lastNotifyAt = Date.now();
    this.state.dailyCount += 1;

    // 推送的标记为 seen（不管主模型最终回不回，都不会再推第二次）
    for (const c of comments) {
      this.markSeen(c.commentId, c.feedTid, c.parentCommentId);
    }
    this.saveState();

    // 构建事件正文：按动态分组列出所有新评论
    const lines: string[] = [];
    const byFeed = new Map<string, NewComment[]>();
    for (const c of comments) {
      const arr = byFeed.get(c.feedTid) ?? [];
      arr.push(c);
      byFeed.set(c.feedTid, arr);
    }

    for (const [tid, list] of byFeed) {
      const feedText = list[0]!.feedText.slice(0, 80);
      lines.push(`动态「${feedText}」（tid=${tid}）：`);
      for (const c of list) {
        // 区分顶级评论和楼中楼回复
        if (c.parentCommentId) {
          lines.push(`  ${c.name || '某人'} 回复了评论：「${c.content}」`);
        } else {
          lines.push(`  ${c.name || '某人'} 评论：「${c.content}」`);
        }
      }
    }

    let text = `QQ空间有 ${comments.length} 条新评论：\n${lines.join('\n')}`;
    if (deferred > 0) {
      text += `\n（还有 ${deferred} 条评论留到下次推送）`;
    }
    text += `\n请用 qq_qzone(action=reply, tid=对应动态的tid, content=你的回复) 逐条回复。`;

    // meta 里带结构化的评论列表，方便主模型程序化处理
    const commentList = comments.map((c) => ({
      tid: c.feedTid,
      commentId: c.commentId,
      operatorNick: c.name,
      operatorUin: c.uin,
      original: c.content,
      feedText: c.feedText.slice(0, 200),
      parentCommentId: c.parentCommentId,
      isReply: !!c.parentCommentId,
    }));

    // senderKey 用第一条评论的 tid（事件归属到哪个会话由框架处理）
    const firstTid = comments[0]!.feedTid;

    void this.host.pushEvent({
      type: 'qq.qzone.comment',
      senderKey: `qzone:${firstTid}`,
      text,
      meta: {
        conv: `qzone:${firstTid}`,
        comments: commentList,
        count: comments.length,
      },
    });

    this.host.log.info('notified comments', { count: comments.length, tids: [...byFeed.keys()] });
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
          initialized: typeof raw.initialized === 'boolean' ? raw.initialized : false,
        };
      }
    } catch {
      // 加载失败不阻断启动，用空状态
    }
    return { seenComments: [], day: '', dailyCount: 0, lastNotifyAt: 0, initialized: false };
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(this.state), 'utf8');
    } catch (e) {
      this.host?.log.warn('save state failed', e);
    }
  }

  private markSeen(commentId: string, tid: string, parentCommentId: string): void {
    const key = `${tid}:${parentCommentId}:${commentId}`;
    if (!this.state.seenComments.includes(key)) {
      this.state.seenComments.push(key);
    }
  }
}
