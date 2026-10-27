/**
 * QQ 空间轮询器：调 SnowLuma 的 HTTP API 拉动态和评论，对比上次的状态筛出新评论。
 *
 * 用到的 SnowLuma API（OneBot v11 扩展）：
 * - get_qzone_feeds    : 拉好友空间动态列表（也含自己的）
 * - get_qzone_msg_detail : 拉单条动态的详情和全部评论
 *
 * 这两个 API 返回的数据结构随 SnowLuma 版本可能变化，这里做宽松解析：
 * 字段缺失就给默认值，不抛错——轮询要稳，单次解析失败不该影响下一次。
 */
import type { Logger } from 'cortico/core/types.ts';

/** 一条评论（已规整，剥内联 @ 标记）。 */
export interface QzoneComment {
  commentId: string;
  uin: string;
  name: string;
  content: string;
  time: number;
}

/** 一条动态（只取轮询需要的字段）。 */
export interface QzoneFeed {
  tid: string;
  uin: string;
  nickname: string;
  text: string;
}

/** 轮询发现的新评论（附带了它来自哪条动态）。 */
export interface NewComment extends QzoneComment {
  feedTid: string;
  feedText: string;
  feedUin: string;
  feedNickname: string;
}

export interface PollerOptions {
  httpUrl: string;
  token: string;
  feedsPerPoll: number;
  log: Logger;
}

export class QzonePoller {
  constructor(private readonly opts: PollerOptions) {}

  /** 调 SnowLuma HTTP API。 */
  private async callApi(action: string, params: Record<string, unknown>): Promise<unknown> {
    const url = `${this.opts.httpUrl.replace(/\/+$/, '')}/${action}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.token) headers['authorization'] = `Bearer ${this.opts.token}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${action}`);
    const result: unknown = await resp.json();
    if (!result || typeof result !== 'object') throw new Error(`${action}: invalid response`);
    const env = result as { status?: string; retcode?: number; data?: unknown };
    if (env.status !== 'ok' || Number(env.retcode) !== 0) {
      throw new Error(`${action}: failed (retcode ${env.retcode ?? 'missing'})`);
    }
    return env.data;
  }

  /** 拉最近几条动态。 */
  async getFeeds(): Promise<QzoneFeed[]> {
    const raw = await this.callApi('get_qzone_feeds', {
      page_num: 1,
      count: this.opts.feedsPerPoll,
    });
    const data = (raw ?? {}) as { feeds?: Array<Record<string, unknown>> };
    const feeds = Array.isArray(data.feeds) ? data.feeds : [];
    return feeds.map((f) => ({
      tid: String(f.key ?? f.tid ?? ''),
      uin: String(f.uin ?? ''),
      nickname: String(f.nickname ?? '').trim(),
      text: typeof f.html === 'string'
        ? QzonePoller.stripHtml(f.html)
        : (typeof f.content === 'string' ? f.content : ''),
    })).filter((f) => f.tid);
  }

  /** 拉一条动态的评论列表。 */
  async getComments(tid: string, uin?: string): Promise<QzoneComment[]> {
    const params: Record<string, unknown> = { tid };
    const u = Number(uin);
    if (Number.isFinite(u) && u > 0) params.target_uin = u;
    const raw = await this.callApi('get_qzone_msg_detail', params);
    const d = (raw ?? {}) as { comments?: Array<Record<string, unknown>> };
    const comments = Array.isArray(d.comments) ? d.comments : [];
    return comments.map((c) => ({
      commentId: String(c.comment_id ?? c.commentId ?? ''),
      uin: String(c.uin ?? ''),
      name: String(c.name ?? '').trim(),
      content: QzonePoller.humanizeAtMarks(String(c.content ?? '')),
      time: Number(c.time ?? 0),
    })).filter((c) => c.commentId);
  }

  /** HTML 片段转纯文本（供可读性）。 */
  private static stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  /** QQ 空间内联 @ 标记转可读文本。 */
  private static humanizeAtMarks(text: string): string {
    return text
      .replace(/@\{[^}]*?uin:([^,}]+)[^}]*?nick:([^,}]+)[^}]*?\}/g, (_m, u, n) => `@${String(n).trim()}(uin:${String(u).trim()})`)
      .replace(/@\{[^}]*?nick:([^,}]+)[^}]*?uin:([^,}]+)[^}]*?\}/g, (_m, n, u) => `@${String(n).trim()}(uin:${String(u).trim()})`);
  }
}
