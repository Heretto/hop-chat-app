import { ChangeDetectionStrategy, Component, ElementRef, HostListener, inject, Input, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Clipboard } from '@angular/cdk/clipboard';
import { forkJoin } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  AgentSummary, Credential, HopAgentService, HopConfirmDialogComponent, HopCredentialService,
} from '@heretto/hop-ui';

import { AgentLogComponent, TraceEvent } from './agent-log.component';
import { ChatAppConversationsComponent } from './chat-app-conversations.component';
import { Appearance, ChatApp, ChatAppService, ChatAppWrite, DEFAULT_APPEARANCE } from './chat-app.service';

const DEPLOY_TYPE = 'heretto_deploy';

interface Draft {
  name: string;
  description: string;
  agent_id: string | null;
  deploy_credential_id: string | null;
  is_active: boolean;
  appearance: Appearance;
  origins: string; // one per line in the form
}

@Component({
  selector: 'app-chat-app-editor',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    CommonModule, FormsModule, RouterLink, MatButtonModule, MatButtonToggleModule, MatCardModule,
    MatDialogModule, MatFormFieldModule, MatIconModule, MatInputModule, MatProgressSpinnerModule,
    MatSelectModule, MatSlideToggleModule, MatSnackBarModule, MatTabsModule, MatTooltipModule,
    ChatAppConversationsComponent, AgentLogComponent,
  ],
  template: `
    <div class="hop-page">
      <div class="loading" *ngIf="loading"><mat-spinner diameter="40"></mat-spinner></div>

      <ng-container *ngIf="!loading && draft">
        <div class="page-header">
          <button mat-icon-button (click)="back()" aria-label="Back to chat apps" matTooltip="Back to chat apps">
            <mat-icon>arrow_back</mat-icon>
          </button>
          <div class="heading">
            <h1>{{ app ? (draft.name || 'Untitled chat app') : 'New Chat App' }}</h1>
            <div class="sub" *ngIf="app">
              <span class="mono">{{ app.chat_url }}</span>
              <button mat-icon-button (click)="copy(app.chat_url, 'Chat URL copied')" aria-label="Copy chat URL" matTooltip="Copy URL"><mat-icon>content_copy</mat-icon></button>
              <a mat-icon-button [href]="app.chat_url" target="_blank" rel="noopener" aria-label="Open chat page" matTooltip="Open chat page"><mat-icon>open_in_new</mat-icon></a>
            </div>
          </div>
          <div class="header-actions">
            <mat-slide-toggle [(ngModel)]="draft.is_active" name="active">{{ draft.is_active ? 'On' : 'Off' }}</mat-slide-toggle>
            <button mat-raised-button color="primary" (click)="save()" [disabled]="saving || !draft.name.trim() || (app && !dirty)">
              {{ app ? (saving ? 'Saving…' : 'Save') : (saving ? 'Creating…' : 'Create') }}
            </button>
          </div>
        </div>

        <div class="callout warning" *ngIf="app?.problems?.length">
          <mat-icon>error_outline</mat-icon>
          <div>
            <strong>This chat can't answer yet.</strong>
            <ul><li *ngFor="let p of app!.problems">{{ p }}</li></ul>
          </div>
        </div>
        <div class="callout info" *ngIf="app && dirty">
          <mat-icon>info</mat-icon><div>You have unsaved changes. The live chat and the Test tab show the saved version.</div>
        </div>

        <mat-tab-group [(selectedIndex)]="tab" animationDuration="0ms">
          <!-- Setup -->
          <mat-tab label="Setup">
            <div class="tab-body">
              <mat-card class="section">
                <mat-card-content>
                  <h3>Chat app</h3>
                  <mat-form-field appearance="outline" class="full">
                    <mat-label>Name</mat-label>
                    <input matInput [(ngModel)]="draft.name" name="name" required maxlength="255" placeholder="Product docs — website">
                    <mat-hint>For you; visitors see the title on the Appearance tab.</mat-hint>
                  </mat-form-field>
                  <mat-form-field appearance="outline" class="full">
                    <mat-label>Description</mat-label>
                    <textarea matInput [(ngModel)]="draft.description" name="description" rows="2" maxlength="2000"
                              placeholder="Where this chat is embedded, who it's for"></textarea>
                  </mat-form-field>
                </mat-card-content>
              </mat-card>

              <mat-card class="section">

                <mat-card-content>
                  <h3>Agent</h3>
                  <p class="help">
                    The agent is the AI behind the chat: its AI configuration (provider and model), description,
                    context files, reference URLs and memory all shape every answer. Several chat apps can share one agent.
                  </p>
                  <mat-form-field appearance="outline" class="full">
                    <mat-label>Agent</mat-label>
                    <mat-select [(ngModel)]="draft.agent_id" name="agent">
                      <mat-option [value]="null">None</mat-option>
                      <mat-option *ngFor="let a of agents" [value]="a.id">
                        {{ a.name }}
                        <span class="option-detail" *ngIf="a.ai_configuration">— {{ a.ai_configuration.name }}</span>
                        <span class="option-detail" *ngIf="!a.ai_configuration">— no AI configuration</span>
                        <span class="option-detail" *ngIf="!a.is_active">(inactive)</span>
                      </mat-option>
                    </mat-select>
                  </mat-form-field>
                  <div class="links">
                    <a mat-button *ngIf="draft.agent_id" [routerLink]="['/agents', draft.agent_id]"><mat-icon>edit</mat-icon>Edit this agent</a>
                    <a mat-button routerLink="/agents/new"><mat-icon>add</mat-icon>New agent</a>
                  </div>
                </mat-card-content>
              </mat-card>

              <mat-card class="section">

                <mat-card-content>
                  <h3>Content</h3>
                  <p class="help">
                    The Heretto Deploy deployment the chat searches and answers from. The credential holds the
                    organization, deployment, token, portal URL and an optional audience filter.
                  </p>
                  <mat-form-field appearance="outline" class="full">
                    <mat-label>Heretto Deploy credential</mat-label>
                    <mat-select [(ngModel)]="draft.deploy_credential_id" name="deploy">
                      <mat-option [value]="null">None</mat-option>
                      <mat-option *ngFor="let c of deployCredentials" [value]="c.id">
                        {{ c.name }}
                        <span class="option-detail">— {{ c.values['organization_id'] }} / {{ c.values['deployment_id'] }}</span>
                      </mat-option>
                    </mat-select>
                  </mat-form-field>
                  <div class="links">
                    <a mat-button routerLink="/credentials"><mat-icon>key</mat-icon>Manage credentials</a>
                  </div>
                </mat-card-content>
              </mat-card>
            </div>
          </mat-tab>

          <!-- Appearance -->
          <mat-tab label="Appearance">
            <div class="tab-body appearance">
              <mat-card class="section">
                <mat-card-content>
                  <h3>Text</h3>
                  <mat-form-field appearance="outline" class="full">
                    <mat-label>Title</mat-label>
                    <input matInput [(ngModel)]="draft.appearance.title" name="title" maxlength="80">
                  </mat-form-field>
                  <mat-form-field appearance="outline" class="full">
                    <mat-label>Subtitle</mat-label>
                    <input matInput [(ngModel)]="draft.appearance.subtitle" name="subtitle" maxlength="120">
                  </mat-form-field>
                  <mat-form-field appearance="outline" class="full">
                    <mat-label>Welcome message</mat-label>
                    <textarea matInput [(ngModel)]="draft.appearance.welcome_message" name="welcome" rows="3" maxlength="1000"></textarea>
                    <mat-hint>Shown at the start of every new conversation. Markdown is supported.</mat-hint>
                  </mat-form-field>
                  <mat-form-field appearance="outline" class="full">
                    <mat-label>Input placeholder</mat-label>
                    <input matInput [(ngModel)]="draft.appearance.input_placeholder" name="placeholder" maxlength="80">
                  </mat-form-field>

                  <h3>Suggested questions</h3>
                  <p class="help">Up to six one-click starting points, shown under the welcome message.</p>
                  <div class="prompt-row" *ngFor="let p of draft.appearance.suggested_prompts; let i = index; trackBy: trackIndex">
                    <mat-form-field appearance="outline" class="grow">
                      <mat-label>Question {{ i + 1 }}</mat-label>
                      <input matInput [(ngModel)]="draft.appearance.suggested_prompts[i]" [name]="'prompt' + i" maxlength="120">
                    </mat-form-field>
                    <button mat-icon-button (click)="removePrompt(i)" aria-label="Remove question"><mat-icon>close</mat-icon></button>
                  </div>
                  <button mat-stroked-button (click)="addPrompt()" [disabled]="draft.appearance.suggested_prompts.length >= 6">
                    <mat-icon>add</mat-icon>Add question
                  </button>

                  <h3>Style</h3>
                  <div class="color-row">
                    <input type="color" [(ngModel)]="draft.appearance.accent_color" name="colorPicker" aria-label="Accent colour">
                    <mat-form-field appearance="outline">
                      <mat-label>Accent colour</mat-label>
                      <input matInput [(ngModel)]="draft.appearance.accent_color" name="color" pattern="#[0-9a-fA-F]{6}" maxlength="7">
                    </mat-form-field>
                  </div>
                  <div class="toggle-row">
                    <span class="label">Launcher position</span>
                    <mat-button-toggle-group [(ngModel)]="draft.appearance.position" name="position">
                      <mat-button-toggle value="left">Bottom left</mat-button-toggle>
                      <mat-button-toggle value="right">Bottom right</mat-button-toggle>
                    </mat-button-toggle-group>
                  </div>
                  <mat-slide-toggle [(ngModel)]="draft.appearance.show_sources" name="sources">
                    Show the topics each answer came from
                  </mat-slide-toggle>
                </mat-card-content>
              </mat-card>

              <div class="preview-wrap" aria-label="Preview">
                <div class="preview-label">Preview</div>
                <div class="preview" [style.--accent]="draft.appearance.accent_color" [style.--on-accent]="onAccent(draft.appearance.accent_color)">
                  <div class="p-header">
                    <div class="p-title">{{ draft.appearance.title || 'Untitled' }}</div>
                    <div class="p-sub" *ngIf="draft.appearance.subtitle">{{ draft.appearance.subtitle }}</div>
                  </div>
                  <div class="p-body">
                    <div class="p-bubble" *ngIf="draft.appearance.welcome_message">{{ draft.appearance.welcome_message }}</div>
                    <div class="p-chips">
                      <span class="p-chip" *ngFor="let p of draft.appearance.suggested_prompts" [hidden]="!p.trim()">{{ p }}</span>
                    </div>
                    <div class="p-user">How do I get started?</div>
                  </div>
                  <div class="p-input"><span>{{ draft.appearance.input_placeholder }}</span><span class="p-send"><mat-icon>arrow_forward</mat-icon></span></div>
                </div>
                <div class="launcher-demo" [class.left]="draft.appearance.position === 'left'">
                  <span class="p-launcher" [style.background]="draft.appearance.accent_color" [style.color]="onAccent(draft.appearance.accent_color)"><mat-icon>chat</mat-icon></span>
                </div>
              </div>
            </div>
          </mat-tab>

          <!-- Embed -->
          <mat-tab label="Embed" [disabled]="!app">
            <div class="tab-body" *ngIf="app">
              <mat-card class="section">
                <mat-card-content>
                  <h3>Add to a website or web app</h3>
                  <p class="help">
                    Paste this before the closing <code>&lt;/body&gt;</code> tag. It adds a chat bubble in the
                    {{ app.appearance.position === 'left' ? 'bottom-left' : 'bottom-right' }} corner that opens the chat.
                  </p>
                  <div class="hop-code-panel snippet"><pre>{{ app.embed_snippet }}</pre></div>
                  <div class="links">
                    <button mat-stroked-button (click)="copy(app.embed_snippet, 'Embed snippet copied')"><mat-icon>content_copy</mat-icon>Copy snippet</button>
                  </div>
                  <h3>Open it from your own UI</h3>
                  <p class="help">The script exposes a small API, so a "Help" button or menu item can open the chat:</p>
                  <div class="hop-code-panel"><pre>{{ apiExample }}</pre></div>
                  <h3>Link to it directly</h3>
                  <p class="help">The chat app's own URL is a full-page chat — use it in emails, help menus or a native app's web view.</p>
                  <div class="hop-query-block"><span class="hop-query-block-label">URL</span><code>{{ app.chat_url }}</code></div>
                </mat-card-content>
              </mat-card>

              <mat-card class="section">

                <mat-card-content>
                  <h3>Where it may be embedded</h3>
                  <p class="help">
                    Sites allowed to show the chat in a frame, one per line (for example <code>https://www.example.com</code>
                    or <code>https://*.example.com</code>). Leave empty to allow any site. The direct URL works everywhere either way.
                  </p>
                  <mat-form-field appearance="outline" class="full">
                    <mat-label>Allowed sites</mat-label>
                    <textarea matInput [(ngModel)]="draft.origins" name="origins" rows="4" placeholder="https://www.example.com"></textarea>
                  </mat-form-field>
                </mat-card-content>
              </mat-card>

              <mat-card class="section danger">

                <mat-card-content>
                  <h3>Replace the URL</h3>
                  <p class="help">Issues a new URL and embed snippet. The current ones stop working immediately, and visitors' previous conversations stay with the old address.</p>
                  <button mat-stroked-button (click)="rotate()"><mat-icon>autorenew</mat-icon>Generate a new URL</button>
                </mat-card-content>
              </mat-card>
            </div>
          </mat-tab>

          <!-- Conversations -->
          <mat-tab [label]="'Conversations' + (app ? ' (' + app.conversation_count + ')' : '')" [disabled]="!app">
            <ng-template matTabContent>
              <div class="tab-body" *ngIf="app"><app-chat-app-conversations [chatAppId]="app.id"></app-chat-app-conversations></div>
            </ng-template>
          </mat-tab>

          <!-- Test -->
          <mat-tab label="Test" [disabled]="!app">
            <ng-template matTabContent>
              <div class="tab-body" *ngIf="app">
                <p class="help">
                  This is the live chat, exactly as visitors get it, with a log of what the agent does for each
                  message. Only this tab sees the log. Test conversations are real ones: they are stored and appear
                  under Conversations.
                </p>
                <div class="test-layout">
                  <div class="test-chat">
                    <div class="test-frame">
                      <iframe #testFrame *ngIf="testUrl" [src]="testUrl" title="Chat test"></iframe>
                    </div>
                    <button mat-button (click)="reloadTest()"><mat-icon>refresh</mat-icon>Reload chat</button>
                  </div>
                  <app-agent-log [events]="traceEvents" (clear)="traceEvents = []"></app-agent-log>
                </div>
              </div>
            </ng-template>
          </mat-tab>
        </mat-tab-group>
      </ng-container>
    </div>
  `,
  styles: [`
    .loading { display: flex; justify-content: center; padding: 64px; }
    .page-header { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
    .heading { flex: 1; min-width: 240px; }
    .heading h1 { margin: 2px 0 0; font-size: 1.75rem; }
    .sub { display: flex; align-items: center; gap: 2px; color: var(--text-tertiary); flex-wrap: wrap; }
    .mono { font-family: var(--font-mono); font-size: 0.85rem; overflow-wrap: anywhere; }
    .header-actions { display: flex; align-items: center; gap: 16px; padding-top: 6px; }
    .callout { display: flex; gap: 10px; align-items: flex-start; border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
    .callout ul { margin: 4px 0 0; padding-left: 18px; }
    .callout.warning { background: var(--color-warning-bg); color: var(--color-warning-text); border: 1px solid var(--color-warning-border); }
    .callout.info { background: var(--color-info-bg); color: var(--color-info-text); }
    .tab-body { padding: 20px 0; display: flex; flex-direction: column; gap: 16px; }
    .section { max-width: 760px; }
    .section h3 { margin: 8px 0 4px; font-size: 1rem; }
    .section h3:not(:first-child) { margin-top: 20px; }
    .help { margin: 0 0 8px; max-width: 72ch; }
    .full { width: 100%; }
    .grow { flex: 1; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; }
    .option-detail { color: var(--text-tertiary); }
    .prompt-row { display: flex; align-items: center; gap: 4px; }
    .color-row { display: flex; align-items: center; gap: 12px; }
    .color-row input[type=color] { width: 44px; height: 44px; padding: 0; border: 1px solid var(--border-strong); border-radius: 8px; background: none; cursor: pointer; margin-top: 12px; }
    .toggle-row { display: flex; align-items: center; gap: 16px; margin: 12px 0 16px; flex-wrap: wrap; }
    .toggle-row .label { color: var(--text-secondary); }
    .snippet pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .danger { border-color: var(--color-error-border); }

    .appearance { flex-direction: row; align-items: flex-start; flex-wrap: wrap; }
    .appearance .section { flex: 1 1 420px; }
    .preview-wrap { flex: 0 1 340px; position: sticky; top: 16px; }
    .preview-label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); margin-bottom: 8px; }
    .preview { border: 1px solid var(--border-default); border-radius: 12px; overflow: hidden; background: var(--bg-primary); display: flex; flex-direction: column; height: 460px; }
    .p-header { background: var(--accent); color: var(--on-accent); padding: 12px 16px; }
    .p-title { font-weight: 600; }
    .p-sub { font-size: 0.8rem; opacity: 0.8; }
    .p-body { flex: 1; padding: 14px; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
    .p-bubble { background: var(--surface-sunken); border-radius: 12px 12px 12px 4px; padding: 8px 10px; max-width: 88%; white-space: pre-wrap; color: var(--text-primary); font-size: 0.9rem; }
    .p-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .p-chip { border: 1px solid var(--border-strong); border-radius: 9999px; padding: 3px 10px; font-size: 0.8rem; color: var(--text-primary); }
    .p-user { align-self: flex-end; background: var(--accent); color: var(--on-accent); border-radius: 12px 12px 4px 12px; padding: 8px 10px; font-size: 0.9rem; }
    .p-input { margin: 10px; border: 1px solid var(--border-strong); border-radius: 12px; padding: 6px 6px 6px 12px; display: flex; justify-content: space-between; align-items: center; color: var(--text-tertiary); font-size: 0.9rem; }
    .p-send { background: var(--accent); color: var(--on-accent); border-radius: 8px; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; }
    .p-send mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .launcher-demo { display: flex; justify-content: flex-end; margin-top: 12px; }
    .launcher-demo.left { justify-content: flex-start; }
    .p-launcher { width: 48px; height: 48px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; }

    .test-layout { display: grid; grid-template-columns: 420px minmax(0, 1fr); gap: 16px; align-items: start; }
    .test-chat { min-width: 0; }
    .test-frame { width: 100%; height: 640px; border: 1px solid var(--border-default); border-radius: 12px; overflow: hidden; background: var(--bg-primary); }
    @media (max-width: 1100px) { .test-layout { grid-template-columns: 1fr; } .test-frame { max-width: 420px; } }
    .test-frame iframe { width: 100%; height: 100%; border: 0; display: block; }
    @media (max-width: 768px) { .preview-wrap { position: static; flex-basis: 100%; } }
  `],
})
export class ChatAppEditorComponent implements OnInit {
  /** Bound from the route; undefined on /chat-apps/new. */
  @Input() chatAppId?: string;

  private service = inject(ChatAppService);
  private agentService = inject(HopAgentService);
  private credentialService = inject(HopCredentialService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private clipboard = inject(Clipboard);
  private sanitizer = inject(DomSanitizer);

  app: ChatApp | null = null;
  draft: Draft | null = null;
  private saved = '';
  agents: AgentSummary[] = [];
  deployCredentials: Credential[] = [];
  loading = true;
  saving = false;
  tab = 0;
  testUrl: SafeResourceUrl | null = null;
  traceEvents: TraceEvent[] = [];
  @ViewChild('testFrame') private testFrame?: ElementRef<HTMLIFrameElement>;

  get dirty(): boolean { return !!this.draft && JSON.stringify(this.draft) !== this.saved; }

  get apiExample(): string {
    return [
      `<button onclick="HopChat.open()">Ask the docs</button>`,
      ``,
      `HopChat.open();    // open the chat`,
      `HopChat.close();   // close it`,
      `HopChat.toggle();  // open or close`,
      `HopChat.apps['${this.app?.public_id ?? ''}'].open();  // with several chats on one page`,
    ].join('\n');
  }

  ngOnInit(): void {
    const lists = forkJoin({
      agents: this.agentService.listAgents(),
      credentials: this.credentialService.listCredentials(),
    });
    lists.subscribe({
      next: ({ agents, credentials }) => {
        this.agents = agents;
        this.deployCredentials = credentials.filter(c => c.type === DEPLOY_TYPE);
        if (this.chatAppId) {
          this.service.get(this.chatAppId).subscribe({
            next: app => { this.adopt(app); this.loading = false; },
            error: () => { this.loading = false; this.snackBar.open('Chat app not found', 'Dismiss', { duration: 4000 }); this.back(); },
          });
        } else {
          this.draft = {
            name: '', description: '', is_active: true, origins: '',
            agent_id: agents.length === 1 ? agents[0].id : null,
            deploy_credential_id: this.deployCredentials.length === 1 ? this.deployCredentials[0].id : null,
            appearance: structuredClone(DEFAULT_APPEARANCE),
          };
          this.saved = JSON.stringify(this.draft);
          this.loading = false;
        }
      },
      error: () => { this.loading = false; this.snackBar.open('Could not load agents and credentials', 'Dismiss', { duration: 5000 }); },
    });
  }

  private adopt(app: ChatApp): void {
    this.app = app;
    this.draft = {
      name: app.name,
      description: app.description ?? '',
      agent_id: app.agent_id ?? null,
      deploy_credential_id: app.deploy_credential_id ?? null,
      is_active: app.is_active,
      appearance: structuredClone({ ...DEFAULT_APPEARANCE, ...app.appearance }),
      origins: app.allowed_origins.join('\n'),
    };
    this.saved = JSON.stringify(this.draft);
    if (this.route.snapshot.queryParamMap.get('section') === 'embed') this.tab = 2;
    this.reloadTest();
  }

  private payload(): ChatAppWrite {
    const d = this.draft!;
    return {
      name: d.name.trim(),
      description: d.description.trim() || null,
      agent_id: d.agent_id,
      deploy_credential_id: d.deploy_credential_id,
      is_active: d.is_active,
      appearance: { ...d.appearance, suggested_prompts: d.appearance.suggested_prompts.map(p => p.trim()).filter(Boolean) },
      allowed_origins: d.origins.split(/[\n,]/).map(o => o.trim()).filter(Boolean),
    };
  }

  save(): void {
    if (!this.draft) return;
    this.saving = true;
    const request = this.app ? this.service.update(this.app.id, this.payload()) : this.service.create(this.payload());
    request.subscribe({
      next: app => {
        this.saving = false;
        const created = !this.app;
        this.adopt(app);
        this.snackBar.open(created ? 'Chat app created' : 'Saved', undefined, { duration: 2500 });
        if (created) {
          // Embed is the natural next step after creating one.
          this.router.navigate(['..', app.id], { relativeTo: this.route, replaceUrl: true, queryParams: { section: 'embed' } });
        }
      },
      error: err => {
        this.saving = false;
        this.snackBar.open(this.describe(err), 'Dismiss', { duration: 7000 });
      },
    });
  }

  private describe(err: any): string {
    const detail = err?.error?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail) && detail.length) {
      return detail.map((d: any) => `${(d.loc ?? []).slice(1).join(' › ')}: ${(d.msg ?? '').replace(/^Value error, /, '')}`).join('; ');
    }
    return 'Could not save the chat app';
  }

  rotate(): void {
    if (!this.app) return;
    this.dialog.open(HopConfirmDialogComponent, {
      data: {
        title: 'Generate a new URL?',
        message: 'The current URL and embed snippet stop working immediately. Update every site that embeds this chat.',
        confirmText: 'Generate',
      },
    }).afterClosed().subscribe(ok => {
      if (!ok || !this.app) return;
      this.service.rotatePublicId(this.app.id).subscribe(app => {
        const keep = this.dirty ? this.draft : null;
        this.adopt(app);
        if (keep) this.draft = keep;
        this.snackBar.open('New URL issued', undefined, { duration: 2500 });
      });
    });
  }

  reloadTest(): void {
    if (!this.app) return;
    const publicId = this.app.public_id;
    // A fresh trace token each load, so the log keeps working however long the tab stays open.
    this.service.startTestSession(this.app.id).subscribe({
      next: ({ trace_token }) => this.setTestUrl(publicId, trace_token),
      error: () => this.setTestUrl(publicId, null), // the chat still works, just without the log
    });
  }

  private setTestUrl(publicId: string, traceToken: string | null): void {
    // Same origin as this admin UI, so the chat's frame-ancestors always allows it.
    const trace = traceToken ? `&trace=${encodeURIComponent(traceToken)}` : '';
    const url = `/c/${encodeURIComponent(publicId)}?embed=0${trace}&t=${Date.now()}`;
    this.testUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  /** Trace events forwarded by the test chat — accepted only from our own iframe, on our own origin. */
  @HostListener('window:message', ['$event'])
  onChatMessage(event: MessageEvent): void {
    if (event.origin !== window.location.origin) return;
    if (!this.testFrame || event.source !== this.testFrame.nativeElement.contentWindow) return;
    const data = event.data;
    if (data?.type === 'hop-chat:trace' && data.event && typeof data.event.type === 'string') {
      this.traceEvents = [...this.traceEvents, data.event as TraceEvent];
    }
  }

  addPrompt(): void { this.draft?.appearance.suggested_prompts.push(''); }
  removePrompt(i: number): void { this.draft?.appearance.suggested_prompts.splice(i, 1); }
  trackIndex(i: number): number { return i; }

  onAccent(hex: string): string {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#ffffff';
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#15181e' : '#ffffff';
  }

  copy(text: string, message: string): void {
    this.clipboard.copy(text);
    this.snackBar.open(message, undefined, { duration: 2500 });
  }

  back(): void { this.router.navigate(['..'], { relativeTo: this.route }); }
}
