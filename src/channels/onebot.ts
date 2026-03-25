import { WebSocket } from 'ws';

import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/**
 * OneBot v11 channel — forward WebSocket mode.
 *
 * NanoClaw connects as a WS client to NapCatQQ's WebSocket server.
 *
 * Protocol reference: https://github.com/botuniverse/onebot-11
 */

// --- OneBot v11 event types (subset we care about) ---

interface OneBotMessageEvent {
  post_type: 'message';
  message_type: 'group' | 'private';
  sub_type?: string;
  message_id: number;
  user_id: number;
  group_id?: number;
  message: string | OneBotMessageSegment[];
  raw_message: string;
  sender: {
    user_id: number;
    nickname: string;
    card?: string; // Group nickname
    role?: string;
  };
  time: number;
  self_id: number;
}

interface OneBotMessageSegment {
  type: string;
  data: Record<string, string>;
}

interface OneBotApiResponse {
  status: string;
  retcode: number;
  data: unknown;
  echo?: string;
}

export interface OneBotChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class OneBotChannel implements Channel {
  name = 'onebot';

  private ws: WebSocket | null = null;
  private wsUrl: string;
  private token: string;
  private opts: OneBotChannelOpts;
  private selfId: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  // For request-response API calls
  private pendingCalls = new Map<
    string,
    {
      resolve: (v: OneBotApiResponse) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private callSeq = 0;

  constructor(wsUrl: string, token: string, opts: OneBotChannelOpts) {
    this.wsUrl = wsUrl;
    this.token = token;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    return this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      // NapCatQQ expects token as query parameter
      let url = this.wsUrl;
      if (this.token) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}access_token=${encodeURIComponent(this.token)}`;
      }
      const ws = new WebSocket(url);

      ws.on('open', () => {
        logger.info({ url: this.wsUrl }, 'OneBot WS connected');
        console.log(`\n  OneBot v11: connected to ${this.wsUrl}\n`);
        this.ws = ws;
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());

          // API response (has echo field)
          if (data.echo !== undefined) {
            this.handleApiResponse(data as OneBotApiResponse);
            return;
          }

          // Event dispatch
          if (data.post_type === 'message') {
            this.handleMessage(data as OneBotMessageEvent);
          } else if (data.post_type === 'meta_event') {
            if (data.meta_event_type === 'lifecycle') {
              this.selfId = data.self_id;
              logger.info({ selfId: data.self_id }, 'OneBot lifecycle connect');
            }
          }
        } catch (err) {
          logger.error({ err }, 'Failed to parse OneBot event');
        }
      });

      ws.on('close', () => {
        logger.warn('OneBot WS disconnected');
        this.ws = null;
        this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        logger.error({ err }, 'OneBot WebSocket error');
        if (!resolved) {
          resolved = true;
          // Don't reject — log the error and start reconnecting
          // so nanoclaw can still start with other channels
          logger.warn(
            { url: this.wsUrl },
            'OneBot initial connection failed, will retry',
          );
          resolve();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;

    const delay = 5000;
    logger.info({ delay }, 'OneBot reconnecting...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch(() => {
        // doConnect handles its own errors — reconnect will be scheduled by on('close')
      });
    }, delay);
  }

  private handleMessage(event: OneBotMessageEvent): void {
    // Skip messages from self
    if (this.selfId && event.user_id === this.selfId) return;

    const isGroup = event.message_type === 'group';
    const chatId = isGroup ? event.group_id! : event.user_id;
    const chatJid = `qq:${chatId}`;
    const content = event.raw_message;
    const timestamp = new Date(event.time * 1000).toISOString();
    const senderName =
      event.sender.card || event.sender.nickname || String(event.user_id);
    const sender = String(event.user_id);
    const msgId = String(event.message_id);

    // Store chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'onebot', isGroup);

    // Only deliver for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered OneBot chat');
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, sender: senderName, length: content.length },
      'OneBot message stored',
    );
  }

  private handleApiResponse(resp: OneBotApiResponse): void {
    if (resp.echo === undefined) return;
    const pending = this.pendingCalls.get(resp.echo);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCalls.delete(resp.echo);
      pending.resolve(resp);
    }
  }

  /** Call a OneBot v11 API action via the WS connection. */
  private callApi(
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10000,
  ): Promise<OneBotApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('OneBot WS not connected'));
        return;
      }

      const echo = String(++this.callSeq);
      const timer = setTimeout(() => {
        this.pendingCalls.delete(echo);
        reject(new Error(`OneBot API call "${action}" timed out`));
      }, timeoutMs);

      this.pendingCalls.set(echo, { resolve, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('OneBot WS not connected, cannot send message');
      return;
    }

    try {
      const id = jid.replace(/^qq:/, '');
      // Determine if group or private based on registered group info
      const group = this.opts.registeredGroups()[jid];
      const isGroup = group !== undefined;

      if (isGroup) {
        await this.callApi('send_group_msg', {
          group_id: Number(id),
          message: text,
        });
      } else {
        await this.callApi('send_private_msg', {
          user_id: Number(id),
          message: text,
        });
      }
      logger.info({ jid, length: text.length }, 'OneBot message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send OneBot message');
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:');
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const [, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
    }
    this.pendingCalls.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('OneBot channel stopped');
  }
}

registerChannel('onebot', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['ONEBOT_WS_URL', 'ONEBOT_TOKEN']);
  const url = process.env.ONEBOT_WS_URL || envVars.ONEBOT_WS_URL || '';
  if (!url) {
    logger.warn('OneBot: ONEBOT_WS_URL not set');
    return null;
  }
  const token = process.env.ONEBOT_TOKEN || envVars.ONEBOT_TOKEN || '';
  return new OneBotChannel(url, token, opts);
});
