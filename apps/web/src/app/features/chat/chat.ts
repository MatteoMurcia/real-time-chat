import { afterNextRender, afterRenderEffect, ChangeDetectionStrategy, Component, effect, ElementRef, inject, input, output, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import type { PublicChannel } from '@real-time-chat/contracts/channels';
import { ChatStore } from './chat.store';

@Component({
  selector: 'app-chat',
  imports: [DatePipe, ReactiveFormsModule],
  providers: [ChatStore],
  templateUrl: './chat.html',
  styleUrl: './chat.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Chat {
  readonly channel = input.required<PublicChannel>();
  readonly closed = output<void>();
  protected readonly store = inject(ChatStore);
  protected readonly draft = new FormControl('', { nonNullable: true });
  protected readonly following = signal(true);
  protected readonly hasNewMessages = signal(false);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private anchor: { element: HTMLElement; offset: number } | undefined;
  private lastLiveNotice = '';

  constructor() {
    effect(() => {
      const channelId = this.channel().id;
      untracked(() => {
        this.anchor = undefined; this.lastLiveNotice = '';
        this.store.open(channelId); this.draft.reset(); this.following.set(true); this.hasNewMessages.set(false);
      });
    });
    afterNextRender(() => this.element.nativeElement.querySelector<HTMLElement>('#conversation-title')?.focus());
    afterRenderEffect(() => {
      const messages = this.store.messages(), liveNotice = this.store.liveNotice();
      this.store.outgoing();
      untracked(() => {
        if (!messages.length) { this.anchor = undefined; this.hasNewMessages.set(false); }
        if (liveNotice && liveNotice !== this.lastLiveNotice && !this.following()) this.hasNewMessages.set(true);
        this.lastLiveNotice = liveNotice;
        if (this.following()) this.scrollToLatest();
        else {
          const log = this.log();
          if (log && this.anchor?.element.isConnected) {
            log.scrollTop += this.anchor.element.getBoundingClientRect().top - log.getBoundingClientRect().top - this.anchor.offset;
          }
          if (log) this.rememberAnchor(log);
        }
      });
    });
  }

  protected send(): void {
    if (this.store.send(this.draft.value)) this.draft.reset();
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.send(); }
  }

  protected scrollToLatest(): void {
    const log = this.log();
    if (log) log.scrollTop = log.scrollHeight;
    this.following.set(true); this.hasNewMessages.set(false); this.anchor = undefined;
  }

  protected loadHistory(): void {
    const log = this.log();
    if (log) { this.rememberAnchor(log); log.focus({ preventScroll: true }); }
    this.following.set(false);
    this.store.loadHistory();
  }

  protected onScroll(event: Event): void {
    const log = event.target as HTMLElement;
    this.following.set(log.scrollHeight - log.scrollTop - log.clientHeight < 40);
    if (this.following()) this.hasNewMessages.set(false);
    this.rememberAnchor(log);
  }

  private log(): HTMLElement | null {
    return this.element.nativeElement.querySelector<HTMLElement>('.messages');
  }

  private rememberAnchor(log: HTMLElement): void {
    const top = log.getBoundingClientRect().top;
    const element = Array.from(log.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find(item => item.getBoundingClientRect().bottom > top);
    this.anchor = element ? { element, offset: element.getBoundingClientRect().top - top } : undefined;
  }
}
