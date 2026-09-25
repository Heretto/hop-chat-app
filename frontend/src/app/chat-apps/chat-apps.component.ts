import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Clipboard } from '@angular/cdk/clipboard';
import { HopConfirmDialogComponent } from '@heretto/hop-ui';

import { ChatApp, ChatAppService } from './chat-app.service';

@Component({
  selector: 'app-chat-apps',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    CommonModule, RouterLink, MatButtonModule, MatCardModule, MatDialogModule, MatIconModule,
    MatMenuModule, MatProgressSpinnerModule, MatSnackBarModule, MatTooltipModule,
  ],
  template: `
    <div class="hop-page">
      <div class="page-header">
        <div>
          <h1>Chat Apps</h1>
          <p class="page-intro">
            A chat app puts an <a routerLink="/agents">agent</a> in front of your visitors: an
            embeddable chat that answers from a Heretto Deploy deployment. Each one has its own
            URL and embed snippet — create one per website or app.
          </p>
        </div>
        <button mat-raised-button color="primary" (click)="create()">
          <mat-icon>add</mat-icon>
          New Chat App
        </button>
      </div>

      <mat-card class="loading-card" *ngIf="loading">
        <mat-card-content>
          <mat-spinner diameter="40"></mat-spinner>
          <p>Loading chat apps…</p>
        </mat-card-content>
      </mat-card>

      <div class="hop-status-message error" *ngIf="error">{{ error }}</div>

      <div class="empty-state" *ngIf="!loading && !error && apps.length === 0">
        <span class="hop-icon-badge accent"><mat-icon>forum</mat-icon></span>
        <h2>No chat apps yet</h2>
        <p>
          You'll need an <a routerLink="/agents">agent</a> with an AI configuration and a
          <a routerLink="/credentials">Heretto Deploy credential</a>. Then create a chat app to put them on a site.
        </p>
        <button mat-raised-button color="primary" (click)="create()">
          <mat-icon>add</mat-icon>
          New Chat App
        </button>
      </div>

      <div class="app-list" *ngIf="!loading && apps.length > 0">
        <mat-card *ngFor="let app of apps"
                  class="app-card"
                  [class.hop-card-accent]="app.is_active && !app.problems.length"
                  [class.inactive]="!app.is_active"
                  role="button" tabindex="0"
                  [attr.aria-label]="'Open ' + app.name"
                  (click)="open(app)" (keydown.enter)="open(app)"
                  (keydown.space)="open(app); $event.preventDefault()">
          <mat-card-content>
            <div class="app-row">
              <span class="swatch" [style.background]="app.appearance.accent_color" aria-hidden="true">
                <mat-icon>chat_bubble</mat-icon>
              </span>
              <div class="app-main">
                <div class="app-title">
                  <h2>{{ app.name }}</h2>
                  <span class="hop-status-chip" *ngIf="!app.is_active">Off</span>
                  <span class="hop-status-chip hop-status-chip-completed" *ngIf="app.is_active && !app.problems.length">Live</span>
                  <span class="hop-status-chip hop-status-chip-pending" *ngIf="app.is_active && app.problems.length">Needs setup</span>
                </div>
                <p class="app-description" *ngIf="app.description">{{ app.description }}</p>
                <div class="facts">
                  <span class="fact" matTooltip="Agent">
                    <mat-icon>smart_toy</mat-icon>{{ app.agent?.name || 'No agent' }}
                  </span>
                  <span class="fact" matTooltip="Heretto Deploy deployment">
                    <mat-icon>cloud_done</mat-icon>{{ app.deploy_credential?.name || 'No deployment' }}
                  </span>
                  <span class="fact" matTooltip="Conversations">
                    <mat-icon>forum</mat-icon>{{ app.conversation_count }}
                    {{ app.conversation_count === 1 ? 'conversation' : 'conversations' }}
                  </span>
                  <span class="fact mono">/c/{{ app.public_id }}</span>
                </div>
              </div>
              <div class="app-actions" (click)="$event.stopPropagation()">
                <button mat-icon-button [matMenuTriggerFor]="menu" [attr.aria-label]="'Actions for ' + app.name">
                  <mat-icon>more_vert</mat-icon>
                </button>
                <mat-menu #menu="matMenu">
                  <a mat-menu-item [href]="app.chat_url" target="_blank" rel="noopener">
                    <mat-icon>open_in_new</mat-icon><span>Open chat page</span>
                  </a>
                  <button mat-menu-item (click)="copySnippet(app)">
                    <mat-icon>code</mat-icon><span>Copy embed snippet</span>
                  </button>
                  <button mat-menu-item (click)="toggle(app)">
                    <mat-icon>{{ app.is_active ? 'pause_circle' : 'play_circle' }}</mat-icon>
                    <span>{{ app.is_active ? 'Turn off' : 'Turn on' }}</span>
                  </button>
                  <button mat-menu-item (click)="remove(app)">
                    <mat-icon>delete</mat-icon><span>Delete</span>
                  </button>
                </mat-menu>
              </div>
            </div>
          </mat-card-content>
        </mat-card>
      </div>
    </div>
  `,
  styles: [`
    .page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
    .page-header h1 { margin-bottom: 4px; }
    .page-intro { max-width: 64ch; margin: 0; }
    .app-list { display: flex; flex-direction: column; gap: 12px; }
    .app-card { cursor: pointer; transition: border-color .15s ease, background-color .15s ease; }
    .app-card:hover { border-color: var(--border-strong); background: var(--hover-overlay); }
    .app-card:focus-visible { outline: none; box-shadow: var(--focus-ring); }
    .app-card.inactive { opacity: 0.7; }
    .app-row { display: flex; align-items: flex-start; gap: 16px; }
    .swatch { flex: none; width: 40px; height: 40px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-inverse); }
    .app-main { flex: 1; min-width: 0; }
    .app-title { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .app-title h2 { margin: 0; font-size: 1.125rem; }
    .app-card:hover .app-title h2 { color: var(--color-accent-text); }
    .app-description { margin: 4px 0 0; }
    .facts { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 12px; color: var(--text-tertiary); }
    .fact { display: inline-flex; align-items: center; gap: 6px; }
    .fact mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .mono { font-family: var(--font-mono); font-size: 0.875rem; }
    .loading-card mat-card-content { display: flex; flex-direction: column; align-items: center; padding: 32px; }
    .empty-state { text-align: center; padding: 64px 24px; }
    .empty-state h2 { margin: 16px 0 4px; }
    .empty-state p { margin: 0 auto 20px; max-width: 56ch; }
  `],
})
export class ChatAppsComponent implements OnInit {
  private service = inject(ChatAppService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private clipboard = inject(Clipboard);

  apps: ChatApp[] = [];
  loading = false;
  error = '';

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.service.list().subscribe({
      next: apps => { this.apps = apps; this.loading = false; this.error = ''; },
      error: err => { this.loading = false; this.error = err.error?.detail || 'Could not load chat apps.'; },
    });
  }

  create(): void { this.router.navigate(['new'], { relativeTo: this.route }); }
  open(app: ChatApp): void { this.router.navigate([app.id], { relativeTo: this.route }); }

  copySnippet(app: ChatApp): void {
    this.clipboard.copy(app.embed_snippet);
    this.snackBar.open('Embed snippet copied', undefined, { duration: 2500 });
  }

  toggle(app: ChatApp): void {
    this.service.update(app.id, { is_active: !app.is_active }).subscribe({
      next: updated => { this.apps = this.apps.map(a => a.id === updated.id ? updated : a); },
      error: err => this.snackBar.open(err.error?.detail || 'Could not update the chat app', 'Dismiss', { duration: 5000 }),
    });
  }

  remove(app: ChatApp): void {
    this.dialog.open(HopConfirmDialogComponent, {
      data: {
        title: `Delete ${app.name}?`,
        message: `Its URL and embed snippet stop working, and all ${app.conversation_count} conversation transcripts are deleted. The agent and credentials are not affected.`,
        confirmText: 'Delete',
      },
    }).afterClosed().subscribe(confirmed => {
      if (!confirmed) return;
      this.service.delete(app.id).subscribe({
        next: () => { this.apps = this.apps.filter(a => a.id !== app.id); this.snackBar.open('Chat app deleted', undefined, { duration: 2500 }); },
        error: err => this.snackBar.open(err.error?.detail || 'Could not delete the chat app', 'Dismiss', { duration: 5000 }),
      });
    });
  }
}
