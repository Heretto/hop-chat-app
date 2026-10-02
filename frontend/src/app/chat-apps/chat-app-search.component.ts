import { ChangeDetectionStrategy, Component, ElementRef, HostListener, inject, Input, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { AgentLogComponent, TraceEvent } from './agent-log.component';
import { ChatApp, ChatAppService, DEFAULT_SEARCH_SETTINGS, SearchSettings, SearchWidget } from './chat-app.service';

/** The editor's form state for search answers (URL parameters edited as one comma-separated field). */
export interface SearchDraft {
  enabled: boolean;
  params: string;
  mount_selector: string;
  mount_position: SearchSettings['mount_position'];
  heading: string;
  skip_keyword_searches: boolean;
}

export function searchDraftFrom(widget?: SearchWidget | null): SearchDraft {
  const s = { ...DEFAULT_SEARCH_SETTINGS, ...(widget?.settings ?? {}) };
  return {
    enabled: !!widget?.enabled,
    params: s.query_params.join(', '),
    mount_selector: s.mount_selector,
    mount_position: s.mount_position,
    heading: s.heading,
    skip_keyword_searches: s.skip_keyword_searches,
  };
}

export function searchWidgetFrom(d: SearchDraft): SearchWidget {
  return {
    enabled: d.enabled,
    settings: {
      query_params: d.params.split(/[\s,]+/).map(p => p.trim()).filter(Boolean),
      mount_selector: d.mount_selector.trim() || DEFAULT_SEARCH_SETTINGS.mount_selector,
      mount_position: d.mount_position,
      heading: d.heading.trim() || DEFAULT_SEARCH_SETTINGS.heading,
      skip_keyword_searches: d.skip_keyword_searches,
    },
  };
}

/**
 * The Search answers tab: an inline answer panel for a docs portal's search
 * results. Settings edit the parent's draft (saved with the rest of the chat
 * app); the tester runs real searches against the saved configuration, with
 * the agent log alongside.
 */
@Component({
  selector: 'app-chat-app-search',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    CommonModule, FormsModule, MatButtonModule, MatCardModule, MatFormFieldModule, MatIconModule,
    MatInputModule, MatSelectModule, MatSlideToggleModule, MatSnackBarModule, AgentLogComponent,
  ],
  template: `
    <div class="tab-body">
      <mat-card class="section">
        <mat-card-content>
          <div class="title-row">
            <h3>Answers in search results</h3>
            <mat-slide-toggle [(ngModel)]="draft.enabled" name="searchEnabled">{{ draft.enabled ? 'On' : 'Off' }}</mat-slide-toggle>
          </div>
          <p class="help">
            Adds a panel to your documentation portal's search page. When a search reads like a question, the agent
            searches and reads your docs and answers it above the results. If it isn't sure, it asks one follow-up
            question instead, often with options to pick from. Keyword searches get no panel. Visitors can reply in
            the panel, which continues as a chat with the same agent.
          </p>
          <div class="callout info" *ngIf="!app">
            <mat-icon>info</mat-icon><div>Create the chat app first; its search settings are saved with it.</div>
          </div>
        </mat-card-content>
      </mat-card>

      <mat-card class="section" *ngIf="draft.enabled">
        <mat-card-content>
          <h3>Finding the search</h3>
          <mat-form-field appearance="outline" class="full">
            <mat-label>URL parameters that hold the search terms</mat-label>
            <input matInput [(ngModel)]="draft.params" name="params" placeholder="q, query">
            <mat-hint>Comma-separated, tried in order: in the query string or a #/route?… URL. Example: /search?q=how+do+I+publish</mat-hint>
          </mat-form-field>

          <h3>Where it appears</h3>
          <div class="pair">
            <mat-form-field appearance="outline" class="grow">
              <mat-label>Mount point (CSS selector)</mat-label>
              <input matInput [(ngModel)]="draft.mount_selector" name="mount" placeholder="[data-hop-answer]">
              <mat-hint>The default matches the placeholder in the snippet below.</mat-hint>
            </mat-form-field>
            <mat-form-field appearance="outline" class="position">
              <mat-label>Placement</mat-label>
              <mat-select [(ngModel)]="draft.mount_position" name="position">
                <mat-option value="prepend">Inside, at the top</mat-option>
                <mat-option value="append">Inside, at the bottom</mat-option>
                <mat-option value="before">Just before it</mat-option>
                <mat-option value="after">Just after it</mat-option>
              </mat-select>
            </mat-form-field>
          </div>
          <mat-form-field appearance="outline" class="full">
            <mat-label>Label above an answer</mat-label>
            <input matInput [(ngModel)]="draft.heading" name="heading" maxlength="60">
          </mat-form-field>

          <h3>Which searches get an AI call</h3>
          <mat-slide-toggle [(ngModel)]="draft.skip_keyword_searches" name="skipKeywords">
            Skip keyword searches without asking the AI
          </mat-slide-toggle>
          <p class="help small">
            On: short keyword searches such as <em>api tokens</em> never call the model. Searches with a question
            mark, a question word ("how", "can", "why", "my…") or five or more words do, and the agent then decides
            whether to answer, ask a follow-up or stay hidden. Off: the agent judges every search, which costs a
            model call per search.
          </p>
        </mat-card-content>
      </mat-card>

      <mat-card class="section" *ngIf="app?.search?.enabled && draft.enabled">
        <mat-card-content>
          <h3>Add it to your portal's search page</h3>
          <p class="help">
            Put this in the search page's template, where the answer should appear, usually just above the results.
            On a single-page portal it can go anywhere: the script waits for the mount point and follows new searches
            as the URL changes. Add the chat's origin to <code>script-src</code> and <code>frame-src</code> if the
            portal sends a Content-Security-Policy, and to the chat app's allowed sites on the Embed tab if you use them.
          </p>
          <div class="hop-code-panel snippet"><pre>{{ app!.search.embed_snippet }}</pre></div>
          <div class="links">
            <button mat-stroked-button (click)="copy(app!.search.embed_snippet)"><mat-icon>content_copy</mat-icon>Copy snippet</button>
          </div>
          <p class="help small">
            If the portal keeps the search terms out of the URL, call <code>HopAnswers.search(terms)</code> after each
            search (and <code>HopAnswers.clear()</code> to remove the panel).
          </p>
        </mat-card-content>
      </mat-card>

      <div class="tester" *ngIf="app">
        <h3>Try a search</h3>
        <p class="help" *ngIf="!app.search.enabled">Turn search answers on and save to try it.</p>
        <p class="help" *ngIf="app.search.enabled && dirty">You have unsaved changes; the tester uses the saved settings.</p>
        <form class="try" *ngIf="app.search.enabled" (ngSubmit)="run()">
          <mat-form-field appearance="outline" class="grow">
            <mat-label>Search as a visitor would</mat-label>
            <input matInput [(ngModel)]="query" name="query" placeholder="how do I publish to PDF?">
          </mat-form-field>
          <button mat-raised-button color="primary" type="submit" [disabled]="!query.trim()">Search</button>
        </form>
        <div class="examples" *ngIf="app.search.enabled">
          <span>Examples:</span>
          <button mat-button type="button" *ngFor="let e of examples" (click)="query = e; run()">{{ e }}</button>
        </div>

        <div class="test-layout" *ngIf="frameUrl">
          <div class="results">
            <div class="fake-portal">
              <div class="fake-search"><mat-icon>search</mat-icon><span>{{ ranQuery }}</span></div>
              <iframe #answerFrame [src]="frameUrl" title="Search answer" [style.height.px]="frameHeight" [hidden]="!frameVisible"></iframe>
              <div class="outcome" *ngIf="!frameVisible && settled">
                <mat-icon>visibility_off</mat-icon>
                <span>No panel for this search — the visitor sees only the results. The agent log shows why.</span>
              </div>
              <div class="fake-result" *ngFor="let i of [1, 2, 3]"><span class="bar w60"></span><span class="bar w90"></span><span class="bar w75"></span></div>
            </div>
          </div>
          <app-agent-log [events]="traceEvents" (clear)="traceEvents = []"></app-agent-log>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .tab-body { padding: 20px 0; display: flex; flex-direction: column; gap: 16px; }
    .section { max-width: 760px; }
    .section h3, .tester h3 { margin: 8px 0 4px; font-size: 1rem; }
    .section h3:not(:first-child) { margin-top: 20px; }
    .title-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .help { margin: 0 0 8px; max-width: 72ch; }
    .help.small { font-size: 0.875rem; color: var(--text-tertiary); margin-top: 8px; }
    .full { width: 100%; }
    .pair { display: flex; gap: 12px; flex-wrap: wrap; }
    .grow { flex: 1 1 260px; }
    .position { flex: 0 1 220px; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; }
    .snippet pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .callout { display: flex; gap: 10px; align-items: flex-start; border-radius: 8px; padding: 12px 14px; }
    .callout.info { background: var(--color-info-bg); color: var(--color-info-text); }

    .try { display: flex; gap: 12px; align-items: flex-start; max-width: 760px; }
    .try button { margin-top: 16px; }
    .examples { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; color: var(--text-tertiary); font-size: 0.875rem; margin-bottom: 12px; }
    .test-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
    .fake-portal { border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-primary); padding: 16px; min-height: 640px; }
    .fake-search { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border-strong); border-radius: 8px; padding: 8px 12px; margin-bottom: 16px; color: var(--text-primary); }
    .fake-search mat-icon { color: var(--text-tertiary); }
    iframe { display: block; width: 100%; border: 0; margin-bottom: 16px; }
    .outcome { display: flex; gap: 8px; align-items: center; color: var(--text-tertiary); font-size: 0.875rem; padding: 10px 12px; border: 1px dashed var(--border-strong); border-radius: 8px; margin-bottom: 16px; }
    .fake-result { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; border-top: 1px solid var(--border-light); }
    .bar { height: 10px; border-radius: 4px; background: var(--surface-sunken); }
    .w60 { width: 60%; background: var(--color-accent-bg); } .w90 { width: 90%; } .w75 { width: 75%; }
    @media (max-width: 1100px) { .test-layout { grid-template-columns: 1fr; } }
  `],
})
export class ChatAppSearchComponent {
  /** The parent's draft object, edited in place so the editor's dirty check and Save cover it. */
  @Input({ required: true }) draft!: SearchDraft;
  @Input() app: ChatApp | null = null;
  @Input() dirty = false;

  @ViewChild('answerFrame') private answerFrame?: ElementRef<HTMLIFrameElement>;

  private service = inject(ChatAppService);
  private sanitizer = inject(DomSanitizer);
  private clipboard = inject(Clipboard);
  private snackBar = inject(MatSnackBar);

  examples = ['api tokens', 'how do I publish to PDF?', 'my build fails'];
  query = '';
  ranQuery = '';
  frameUrl: SafeResourceUrl | null = null;
  frameHeight = 0;
  frameVisible = false;
  settled = false;
  traceEvents: TraceEvent[] = [];

  run(): void {
    const q = this.query.trim();
    if (!q || !this.app) return;
    const publicId = this.app.public_id;
    this.ranQuery = q;
    this.frameVisible = false;
    this.settled = false;
    this.frameHeight = 0;
    this.service.startTestSession(this.app.id).subscribe({
      next: ({ trace_token }) => this.load(publicId, q, trace_token),
      error: () => this.load(publicId, q, null),
    });
  }

  private load(publicId: string, q: string, traceToken: string | null): void {
    // embed=1 so the panel reports its size and visibility to this page, exactly as it would to a portal;
    // cache=0 so the same search can be tried again.
    const trace = traceToken ? `&trace=${encodeURIComponent(traceToken)}` : '';
    const url = `/a/${encodeURIComponent(publicId)}?embed=1&cache=0&q=${encodeURIComponent(q)}${trace}&t=${Date.now()}`;
    this.frameUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  /** Messages from the answer panel: accepted only from our own iframe, on our own origin. */
  @HostListener('window:message', ['$event'])
  onMessage(event: MessageEvent): void {
    if (event.origin !== window.location.origin) return;
    if (!this.answerFrame || event.source !== this.answerFrame.nativeElement.contentWindow) return;
    const data = event.data ?? {};
    switch (data.type) {
      case 'hop-answer:size':
        if (typeof data.height === 'number') this.frameHeight = Math.min(data.height, 2000);
        break;
      case 'hop-answer:visible':
        this.frameVisible = !!data.visible;
        this.settled = true;
        break;
      case 'hop-chat:trace':
        if (data.event && typeof data.event.type === 'string') this.traceEvents = [...this.traceEvents, data.event as TraceEvent];
        break;
    }
  }

  copy(text: string): void {
    this.clipboard.copy(text);
    this.snackBar.open('Snippet copied', undefined, { duration: 2500 });
  }
}
