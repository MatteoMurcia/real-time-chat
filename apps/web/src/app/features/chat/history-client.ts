import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { map, timeout } from 'rxjs';
import type { MessagePage } from '@real-time-chat/contracts/messages';
import { isMessage } from './message';

@Injectable({ providedIn: 'root' })
export class HistoryClient {
  private readonly http = inject(HttpClient);

  list(channelId: string, before: string | null) {
    return this.http.get<MessagePage>(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      params: before ? new HttpParams().set('before', before) : new HttpParams(),
    }).pipe(timeout(5000), map(page => {
      const cursor = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
      if (!page || !Array.isArray(page.items) || page.items.length > 50 || !cursor(page.snapshotCursor)
        || (page.olderCursor !== null && (!cursor(page.olderCursor) || !page.items.length || page.olderCursor === before))
        || !page.items.every(item => isMessage(item) && item.channelId === channelId)
        || new Set(page.items.map(item => item.id)).size !== page.items.length
        || page.items.some((item, index) => index > 0 && BigInt(item.sequence) <= BigInt(page.items[index - 1]!.sequence))) throw new Error('Invalid history page');
      return page;
    }));
  }
}
