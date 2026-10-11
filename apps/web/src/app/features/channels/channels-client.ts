import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { map, timeout } from 'rxjs';
import type { ChannelPage, CreateChannelRequest, PublicChannel } from '@real-time-chat/contracts/channels';
import { AuthClient } from '../../core/auth-client';

function readChannel(value: unknown): PublicChannel {
  if (!value || typeof value !== 'object') throw new Error('Invalid channel response');
  const channel = value as Record<string, unknown>;
  if (!['id', 'name', 'slug', 'createdAt'].every(key => typeof channel[key] === 'string')
    || typeof channel.isMember !== 'boolean' || !Number.isFinite(Date.parse(String(channel.createdAt)))) throw new Error('Invalid channel response');
  const { id, name, slug, createdAt, isMember } = channel as unknown as PublicChannel;
  return { id, name, slug, createdAt, isMember };
}

@Injectable({ providedIn: 'root' })
export class ChannelsClient {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthClient);

  list(cursor: string | null) {
    return this.http.get<ChannelPage>('/api/channels', { params: cursor ? new HttpParams().set('cursor', cursor) : new HttpParams() }).pipe(
      timeout(5000), map(body => {
        if (!body || !Array.isArray(body.channels) || body.channels.length > 100
          || (body.nextCursor !== null && (typeof body.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.nextCursor)))) throw new Error('Invalid channel page');
        return { channels: body.channels.map(readChannel), nextCursor: body.nextCursor };
      }),
    );
  }

  create(input: CreateChannelRequest) {
    return this.auth.authenticatedPost('/api/channels', input).pipe(map(body => {
      if (!body || typeof body !== 'object' || !('channel' in body)) throw new Error('Invalid channel response');
      return readChannel(body.channel);
    }));
  }
}
