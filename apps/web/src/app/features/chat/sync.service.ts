import { inject, Injectable, InjectionToken } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { EMPTY, expand, map, timeout } from 'rxjs';
import type { MessageSyncPage } from '@real-time-chat/contracts/messages';
import { isMessage } from './message';

export const SYNC_INTERVAL_MS = new InjectionToken<number>('Message recovery interval', { providedIn: 'root', factory: () => 15000 });

@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly http = inject(HttpClient);

  recover(channelId: string, after: string) {
    return this.page(channelId, after).pipe(expand(page => page.hasMore
      ? this.page(channelId, page.nextCursor, page.until, page.items.at(-1)!.sequence) : EMPTY, 1));
  }

  private page(channelId: string, after: string, until?: string, previousSequence?: string) {
    let params = new HttpParams().set('after', after);
    if (until) params = params.set('until', until);
    return this.http.get<MessageSyncPage>(`/api/channels/${encodeURIComponent(channelId)}/messages/sync`, { params }).pipe(
      timeout(5000), map(page => {
        const cursor = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
        if (!page || !Array.isArray(page.items) || page.items.length > 50 || typeof page.hasMore !== 'boolean'
          || !cursor(page.until) || !cursor(page.nextCursor) || (until !== undefined && page.until !== until)
          || (page.hasMore ? !page.items.length || page.nextCursor === after || page.nextCursor === page.until : page.nextCursor !== page.until)
          || !page.items.every(item => isMessage(item) && item.channelId === channelId)
          || new Set(page.items.map(item => item.id)).size !== page.items.length
          || page.items.some((item, index) => {
            const previous = index ? page.items[index - 1]!.sequence : previousSequence;
            return previous !== undefined && BigInt(item.sequence) <= BigInt(previous);
          })) throw new Error('Invalid recovery page');
        return page;
      }),
    );
  }
}
