import { ChangeDetectionStrategy, Component, inject, Input, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { HopConfirmDialogComponent } from '@heretto/hop-ui';

import { ChatAppService, Conversation, ConversationSummary } from './chat-app.service';

const PAGE_SIZE = 50;

/** Retained transcripts: a list of conversations, and the one being read. */
@Component({
  selector: 'app-chat-app-conversations',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    CommonModule, MatButtonModule, MatCardModule, MatDialogModule, MatIconModule,
    MatProgressSpinnerModule, MatSnackBarModule, MatTooltipModule,
  ],
  template: `
    <div class="empty" *ngIf="!loading && total === 0">
      <span class="hop-icon-badge"><mat-icon>forum</mat-icon></span>
      <p>No conversations yet. They appear here as soon as a visitor asks something.</p>
    </div>

    <div class="layout" *ngIf="loading || total > 0">
      <!-- Edge-to-edge on purpose: the header and rows carry their own padding. -->
      <mat-card class="list no-pad">
        <div class="list-header">
          <span>{{ total }} {{ total === 1 ? 'conversation' : 'conversations' }}</span>
          <button mat-icon-button (click)="reload()" matTooltip="Refresh" aria-label="Refresh"><mat-icon>refresh</mat-icon></button>
        </div>
        <div class="spinner" *ngIf="loading"><mat-spinner diameter="28"></mat-spinner></div>
        <button type="button" class="row" *ngFor="let c of items"
                [class.selected]="c.id === selected?.id" (click)="select(c)">
          <span class="row-title">{{ c.title }}</span>
          <span class="row-meta">{{ c.visitor }} · {{ c.message_count }} messages · {{ (c.updated_at || c.created_at) | date: 'MMM d, h:mm a' }}</span>
        </button>
        <button mat-button class="more" *ngIf="items.length < total" (click)="more()">Load more</button>
      </mat-card>

      <mat-card class="transcript">
        <mat-card-content>
          <div class="placeholder" *ngIf="!selected && !loadingDetail">Select a conversation to read it.</div>
          <div class="spinner" *ngIf="loadingDetail"><mat-spinner diameter="28"></mat-spinner></div>
          <ng-container *ngIf="selected && !loadingDetail">
            <div class="transcript-header">
              <div>
                <h3>{{ selected.title }}</h3>
                <div class="meta">
                  {{ selected.visitor }} · started {{ selected.created_at | date: 'medium' }}
                  <ng-container *ngIf="selected.locale"> · {{ selected.locale }}</ng-container>
                </div>
                <div class="meta" *ngIf="selected.origin">From <a [href]="selected.origin" target="_blank" rel="noopener">{{ selected.origin }}</a></div>
              </div>
              <button mat-icon-button (click)="remove(selected)" matTooltip="Delete transcript" aria-label="Delete transcript">
                <mat-icon>delete</mat-icon>
              </button>
            </div>
            <div class="messages">
              <div class="msg" *ngFor="let m of selected.messages" [class.user]="m.role === 'user'" [class.failed]="m.details?.error">
                <div class="who">{{ m.role === 'user' ? 'Visitor' : 'Assistant' }} · {{ m.created_at | date: 'h:mm:ss a' }}</div>
                <div class="body">{{ m.content }}</div>
                <div class="callout error" *ngIf="m.details?.error"><mat-icon>error_outline</mat-icon>{{ m.details.error }}</div>
                <div class="sources" *ngIf="m.sources?.length">
                  <mat-icon>menu_book</mat-icon>
                  <ng-container *ngFor="let s of m.sources; let last = last">
                    <a *ngIf="s.url" [href]="s.url" target="_blank" rel="noopener">{{ s.title }}</a>
                    <span *ngIf="!s.url">{{ s.title }}</span><span *ngIf="!last">, </span>
                  </ng-container>
                </div>
                <details class="trace" *ngIf="m.role === 'assistant' && m.details?.model">
                  <summary>{{ m.details.provider }} / {{ m.details.model }} · {{ m.details.tool_calls?.length || 0 }} tool calls</summary>
                  <div class="hop-code-panel"><pre>{{ trace(m) }}</pre></div>
                </details>
              </div>
            </div>
          </ng-container>
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [`
    .empty { text-align: center; padding: 48px 16px; }
    .empty p { margin: 12px 0 0; }
    .layout { display: grid; grid-template-columns: minmax(240px, 340px) 1fr; gap: 16px; align-items: start; }
    .list { overflow: hidden; }
    .list-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 4px 4px 16px; border-bottom: 1px solid var(--border-default); color: var(--text-tertiary); }
    .row { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; padding: 10px 16px; border: 0; border-bottom: 1px solid var(--border-light); background: transparent; cursor: pointer; font: inherit; color: var(--text-primary); }
    .row:hover { background: var(--hover-overlay); }
    .row.selected { background: var(--color-accent-bg); box-shadow: inset 3px 0 0 var(--color-accent); }
    .row-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-meta { font-size: 0.8rem; color: var(--text-tertiary); }
    .more { width: 100%; }
    .spinner { display: flex; justify-content: center; padding: 24px; }
    .transcript { min-height: 320px; }
    .placeholder { color: var(--text-tertiary); padding: 48px 16px; text-align: center; }
    .transcript-header { display: flex; justify-content: space-between; gap: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-default); margin-bottom: 12px; }
    .transcript-header h3 { margin: 0 0 4px; font-size: 1.05rem; }
    .meta { font-size: 0.85rem; color: var(--text-tertiary); overflow-wrap: anywhere; }
    .messages { display: flex; flex-direction: column; gap: 14px; }
    .msg .who { font-size: 0.78rem; color: var(--text-tertiary); margin-bottom: 4px; }
    .msg .body { white-space: pre-wrap; background: var(--surface-sunken); border-radius: 8px; padding: 10px 12px; color: var(--text-primary); overflow-wrap: anywhere; }
    .msg.user .body { background: var(--color-primary-bg); }
    .msg.failed .body { background: var(--color-error-bg); color: var(--color-error-text); }
    .callout.error { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; font-size: 0.85rem; background: var(--color-error-bg); color: var(--color-error-text); border: 1px solid var(--color-error-border); border-radius: 8px; padding: 8px 10px; }
    .callout mat-icon, .sources mat-icon { font-size: 18px; width: 18px; height: 18px; flex: none; }
    .sources { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 6px; font-size: 0.85rem; color: var(--text-secondary); }
    .trace { margin-top: 6px; font-size: 0.82rem; color: var(--text-tertiary); }
    .trace summary { cursor: pointer; }
    .trace .hop-code-panel { margin-top: 6px; max-height: 240px; overflow: auto; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  `],
})
export class ChatAppConversationsComponent implements OnChanges {
  @Input({ required: true }) chatAppId!: string;

  private service = inject(ChatAppService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);

  items: ConversationSummary[] = [];
  total = 0;
  loading = false;
  loadingDetail = false;
  selected: Conversation | null = null;

  ngOnChanges(): void { this.reload(); }

  reload(): void {
    this.loading = true;
    this.service.conversations(this.chatAppId, 0, PAGE_SIZE).subscribe({
      next: page => { this.items = page.items; this.total = page.total; this.loading = false; },
      error: () => { this.loading = false; this.snackBar.open('Could not load conversations', 'Dismiss', { duration: 5000 }); },
    });
  }

  more(): void {
    this.service.conversations(this.chatAppId, this.items.length, PAGE_SIZE).subscribe(page => {
      this.items = [...this.items, ...page.items];
      this.total = page.total;
    });
  }

  select(c: ConversationSummary): void {
    this.loadingDetail = true;
    this.service.conversation(this.chatAppId, c.id).subscribe({
      next: detail => { this.selected = detail; this.loadingDetail = false; },
      error: () => { this.loadingDetail = false; this.snackBar.open('Could not load the transcript', 'Dismiss', { duration: 5000 }); },
    });
  }

  trace(m: Conversation['messages'][number]): string {
    const d = m.details;
    const lines = [`agent: ${d.agent ?? ''}`, `ai configuration: ${d.ai_configuration ?? ''}`];
    for (const call of d.tool_calls ?? []) {
      const args = call.url ?? Object.entries(call.args ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
      lines.push(`→ ${call.tool} ${args}${call.status ? ` [${call.status}]` : ''}`);
    }
    return lines.join('\n');
  }

  remove(c: Conversation): void {
    this.dialog.open(HopConfirmDialogComponent, {
      data: { title: 'Delete this transcript?', message: 'The visitor will no longer see it in their previous conversations either.', confirmText: 'Delete' },
    }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.service.deleteConversation(this.chatAppId, c.id).subscribe(() => {
        this.selected = null;
        this.reload();
      });
    });
  }
}
