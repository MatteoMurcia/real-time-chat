import { afterRenderEffect, ChangeDetectionStrategy, Component, DestroyRef, effect, ElementRef, inject, input, output, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import type { PublicChannel } from '@real-time-chat/contracts/channels';
import { ChatStore } from './chat.store';
import type { Outgoing } from './message.reducer';
import { ActivityService } from '../../core/activity.service';
import { TypingStore } from './typing.store';

@Component({
  selector: 'app-chat',
  imports: [DatePipe, ReactiveFormsModule],
  providers: [ChatStore, TypingStore],
  templateUrl: './chat.html',
  styleUrl: './chat.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Chat {
  readonly channel = input.required<PublicChannel>();
  readonly closed = output<void>();
  protected readonly store = inject(ChatStore);
  protected readonly activity = inject(ActivityService);
  protected readonly typing = inject(TypingStore);
  protected readonly draft = new FormControl('', { nonNullable: true });
  protected readonly following = signal(true);
  protected readonly hasNewMessages = signal(false);
  protected composing = false;
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private anchor: { element: HTMLElement; offset: number } | undefined;
  private lastLiveNotice = '';

  constructor() {
    effect(() => {
      const channelId = this.channel().id, ready = this.store.ready();
      untracked(() => this.typing.open(channelId, ready));
    });
    const observer = new IntersectionObserver(entries => {
      if (!this.activity.visible() || !this.store.ready() || this.store.syncLoading() || this.store.historyLoading()) return;
      const recovered = this.store.recoveredSequence();
      let reached = 0n;
      for (const entry of entries) {
        const sequence = (entry.target as HTMLElement).dataset['readSequence'];
        if (entry.target.isConnected && entry.target.getAttribute('data-read-channel') === this.channel().id
          && entry.isIntersecting && entry.intersectionRatio === 1 && sequence
          && BigInt(sequence) <= BigInt(recovered) && BigInt(sequence) > reached) reached = BigInt(sequence);
      }
      if (reached > 0n) this.activity.mark(this.channel().id, reached.toString());
    }, { threshold: 1 });
    inject(DestroyRef).onDestroy(() => observer.disconnect());
    effect(() => { this.activity.revision(); untracked(() => this.store.recover()); });
    afterRenderEffect(() => {
      this.store.messages(); this.store.recoveredSequence(); this.store.syncLoading(); this.store.historyLoading();
      this.activity.visible(); this.activity.revision();
      observer.disconnect();
      for (const marker of this.element.nativeElement.querySelectorAll('[data-read-sequence]')) observer.observe(marker);
    });
    effect(() => {
      const channelId = this.channel().id;
      untracked(() => {
        this.anchor = undefined; this.lastLiveNotice = ''; this.composing = false;
        this.store.open(channelId); this.draft.reset(); this.following.set(true); this.hasNewMessages.set(false);
      });
    });
    afterRenderEffect(() => {
      this.channel();
      untracked(() => this.element.nativeElement.querySelector<HTMLElement>('#conversation-title')?.focus());
    });
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
    if (!this.composing && this.store.send(this.draft.value)) {
      this.typing.stop();
      this.draft.reset(); this.focusComposer();
    }
  }

  protected onKey(event: KeyboardEvent): void {
    // Some IMEs end composition before the confirming keydown, retaining keyCode 229.
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
      && !this.composing && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); this.send(); }
  }

  protected retry(item: Outgoing): void {
    this.focusComposer(); this.store.retry(item);
  }

  protected recover(): void {
    this.log()?.focus({ preventScroll: true }); this.store.recover();
  }

  private focusComposer(): void {
    this.element.nativeElement.querySelector<HTMLTextAreaElement>('#message-body')?.focus({ preventScroll: true });
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
