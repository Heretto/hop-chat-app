import {
  AfterViewChecked, ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, OnChanges, Output, ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Clipboard } from '@angular/cdk/clipboard';
import { inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

/** One event from the chat's trace stream (see backend app/chat/engine.py and service.py). */
export interface TraceEvent {
  type: string;
  t_ms?: number;
  [key: string]: any;
}

type Tone = 'neutral' | 'running' | 'ok' | 'warn' | 'error';

interface Row {
  icon: string;
  tone: Tone;
  title: string;
  meta: string[];     // short facts after the title: "1.4s", "1,200 → 40 tokens"
  at?: number;        // ms since the turn started
  items?: string[];   // e.g. search result titles
  text?: string;      // longer text shown in a quote, e.g. what the model said
  details?: string;   // expandable raw detail (JSON / system prompt)
  detailsLabel?: string;
}

interface Turn {
  kind: 'turn';
  question: string;
  running: boolean;
  failed: boolean;
  summary: string;
  rows: Row[];
}

interface Divider { kind: 'divider'; label: string; }

type Block = Turn | Divider;

const fmtMs = (ms?: number | null) =>
  ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
const fmtN = (n?: number | null) => (n == null ? '?' : n.toLocaleString());
const quote = (v: unknown) => (typeof v === 'string' ? `“${v}”` : JSON.stringify(v));

/**
 * The Test tab's agent log: what the agent did for each test message — the
 * run's configuration, every model call and its decision, every tool call and
 * what came back, timings and token counts, and the operator's view of errors.
 */
@Component({
  selector: 'app-agent-log',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
    <div class="log">
      <div class="log-header">
        <div class="log-title">
          <mat-icon>terminal</mat-icon>
          <span>Agent log</span>
          <span class="hop-status-chip hop-status-chip-running" *ngIf="running">Working</span>
        </div>
        <div class="log-actions">
          <button mat-icon-button (click)="copy()" [disabled]="!events.length" matTooltip="Copy log as JSON" aria-label="Copy log as JSON">
            <mat-icon>content_copy</mat-icon>
          </button>
          <button mat-icon-button (click)="clear.emit()" [disabled]="!events.length" matTooltip="Clear log" aria-label="Clear log">
            <mat-icon>delete_sweep</mat-icon>
          </button>
        </div>
      </div>

      <div class="log-body" #body (scroll)="onScroll()">
        <div class="empty" *ngIf="!blocks.length">
          <span class="hop-icon-badge"><mat-icon>manage_search</mat-icon></span>
          <p>Send a message in the chat to see what the agent does: the model calls it makes,
            the docs it searches and reads, and how long each step takes.</p>
        </div>

        <ng-container *ngFor="let b of blocks">
          <div class="divider" *ngIf="b.kind === 'divider'"><span>{{ b.label }}</span></div>

          <section class="turn" *ngIf="b.kind === 'turn'" [class.failed]="b.failed">
            <div class="question">
              <mat-icon>person</mat-icon>
              <span class="q-text">{{ b.question }}</span>
            </div>
            <ol class="rows">
              <li *ngFor="let r of b.rows" class="row" [ngClass]="'tone-' + r.tone" [class.hop-shimmer]="r.tone === 'running'">
                <mat-icon class="row-icon">{{ r.icon }}</mat-icon>
                <div class="row-main">
                  <div class="row-line">
                    <span class="row-title">{{ r.title }}</span>
                    <span class="row-meta" *ngFor="let m of r.meta">{{ m }}</span>
                    <span class="row-at" *ngIf="r.at != null">+{{ fmt(r.at) }}</span>
                  </div>
                  <ul class="row-items" *ngIf="r.items?.length">
                    <li *ngFor="let i of r.items">{{ i }}</li>
                  </ul>
                  <div class="row-text" *ngIf="r.text">{{ r.text }}</div>
                  <details *ngIf="r.details">
                    <summary>{{ r.detailsLabel || 'Details' }}</summary>
                    <div class="hop-code-panel"><pre>{{ r.details }}</pre></div>
                  </details>
                </div>
              </li>
            </ol>
            <div class="turn-summary" *ngIf="b.summary">{{ b.summary }}</div>
          </section>
        </ng-container>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .log { display: flex; flex-direction: column; height: 640px; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-primary); overflow: hidden; }
    .log-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 4px 4px 14px; border-bottom: 1px solid var(--border-default); background: var(--bg-secondary); }
    .log-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--text-primary); }
    .log-title mat-icon { color: var(--text-tertiary); }
    .log-actions { display: flex; }
    .log-body { flex: 1; overflow-y: auto; padding: 12px 14px; }
    .empty { text-align: center; padding: 48px 16px; color: var(--text-tertiary); }
    .empty p { max-width: 44ch; margin: 12px auto 0; }

    .divider { display: flex; align-items: center; gap: 10px; margin: 8px 0 12px; color: var(--text-tertiary); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .divider::before, .divider::after { content: ''; flex: 1; border-top: 1px dashed var(--border-strong); }

    .turn { border-left: 3px solid var(--color-accent); padding-left: 12px; margin-bottom: 18px; }
    .turn.failed { border-left-color: var(--color-error); }
    .question { display: flex; gap: 8px; align-items: flex-start; font-weight: 500; color: var(--text-primary); margin-bottom: 8px; }
    .question mat-icon { font-size: 18px; width: 18px; height: 18px; color: var(--text-tertiary); flex: none; margin-top: 2px; }
    .q-text { overflow-wrap: anywhere; }

    .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .row { display: flex; gap: 8px; align-items: flex-start; padding: 5px 6px; border-radius: 8px; font-size: 0.875rem; }
    .row:hover { background: var(--hover-overlay); }
    .row-icon { font-size: 18px; width: 18px; height: 18px; flex: none; margin-top: 1px; color: var(--text-tertiary); }
    .tone-ok .row-icon { color: var(--color-success); }
    .tone-running .row-icon { color: var(--color-accent-text); }
    .tone-warn .row-icon { color: var(--color-warning); }
    .tone-error .row-icon { color: var(--color-error); }
    .tone-error .row-title { color: var(--color-error-text); }
    .row-main { flex: 1; min-width: 0; }
    .row-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
    .row-title { color: var(--text-primary); overflow-wrap: anywhere; }
    .row-meta { color: var(--text-tertiary); font-size: 0.8rem; white-space: nowrap; }
    .row-at { margin-left: auto; color: var(--text-tertiary); font-family: var(--font-mono); font-size: 0.75rem; }
    .row-items { margin: 4px 0 0; padding-left: 18px; color: var(--text-secondary); font-size: 0.82rem; }
    .row-text { margin-top: 4px; padding: 6px 8px; background: var(--surface-sunken); border-radius: 8px; color: var(--text-secondary); font-size: 0.82rem; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 9em; overflow: auto; }
    details { margin-top: 4px; font-size: 0.8rem; color: var(--text-tertiary); }
    details summary { cursor: pointer; }
    details .hop-code-panel { margin-top: 4px; max-height: 280px; overflow: auto; }
    details pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .turn-summary { margin-top: 6px; font-size: 0.8rem; color: var(--text-tertiary); }
  `],
})
export class AgentLogComponent implements OnChanges, AfterViewChecked {
  @Input() events: TraceEvent[] = [];
  @Output() clear = new EventEmitter<void>();
  @ViewChild('body') body?: ElementRef<HTMLElement>;

  private clipboard = inject(Clipboard);
  blocks: Block[] = [];
  running = false;
  private stickToBottom = true;

  fmt = fmtMs;

  ngOnChanges(): void {
    this.blocks = build(this.events);
    const last = this.blocks[this.blocks.length - 1];
    this.running = !!last && last.kind === 'turn' && last.running;
  }

  ngAfterViewChecked(): void {
    const el = this.body?.nativeElement;
    if (el && this.stickToBottom) el.scrollTop = el.scrollHeight;
  }

  onScroll(): void {
    const el = this.body?.nativeElement;
    // Follow new entries unless the operator has scrolled up to read something.
    if (el) this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  copy(): void { this.clipboard.copy(JSON.stringify(this.events, null, 2)); }
}

/** Fold the flat event stream into turns of readable rows. */
function build(events: TraceEvent[]): Block[] {
  const blocks: Block[] = [];
  let turn: Turn | null = null;
  // Rows still waiting for their other half (a model call for its response, a tool call for its result).
  let pendingModel: Row | null = null;
  const pendingTools: Row[] = [];
  let modelCalls = 0, toolCalls = 0, tokensIn = 0, tokensOut = 0;

  const ensureTurn = (question = '(message)') => {
    if (!turn) {
      turn = { kind: 'turn', question, running: true, failed: false, summary: '', rows: [] };
      blocks.push(turn);
    }
    return turn;
  };

  for (const e of events) {
    switch (e.type) {
      case 'conversation.new':
        turn = null;
        blocks.push({ kind: 'divider', label: 'New conversation' });
        break;
      case 'conversation.open':
        turn = null;
        blocks.push({ kind: 'divider', label: `Opened “${e['title']}”` });
        break;
      case 'turn.start':
        turn = null;
        pendingModel = null;
        pendingTools.length = 0;
        modelCalls = toolCalls = tokensIn = tokensOut = 0;
        ensureTurn(e['content'] || '(empty message)');
        break;
      case 'run.start': {
        const d = e['deployment'] || {};
        ensureTurn().rows.push({
          icon: 'play_circle', tone: 'neutral', at: e.t_ms,
          title: `${e['agent']} on ${e['provider']} / ${e['model'] || 'no model'}`,
          meta: [`${e['history_messages']} message${e['history_messages'] === 1 ? '' : 's'} of history`],
          details: [
            `AI configuration: ${e['ai_configuration']}`,
            `Deployment: ${d.title || '(untitled)'} — ${d.organization_id}/${d.deployment_id}${d.audience ? ` (audience: ${d.audience})` : ''}`,
            `Locale: ${e['locale'] || '(browser default)'}`,
            `Tools: ${(e['tools'] || []).join(', ')} · up to ${e['max_tool_rounds']} tool rounds`,
            '',
            '── System prompt ──',
            e['system_prompt'] || '',
          ].join('\n'),
          detailsLabel: 'Configuration and system prompt',
        });
        break;
      }
      case 'deploy.error':
        ensureTurn().rows.push({ icon: 'cloud_off', tone: 'warn', at: e.t_ms, title: e['message'], meta: [] });
        break;
      case 'model.request':
        modelCalls++;
        pendingModel = {
          icon: 'psychology', tone: 'running', at: e.t_ms,
          title: `Model call ${e['iteration']}`,
          meta: [`${e['messages']} messages`, e['tools_allowed'] ? 'tools available' : 'final answer only'],
        };
        ensureTurn().rows.push(pendingModel);
        break;
      case 'model.response': {
        const row: Row = pendingModel ?? { icon: 'psychology', tone: 'ok', title: `Model call ${e['iteration']}`, meta: [] };
        pendingModel = null;
        tokensIn += e['input_tokens'] || 0;
        tokensOut += e['output_tokens'] || 0;
        const calls: { name: string; args: Record<string, unknown> }[] = e['tool_calls'] || [];
        row.tone = 'ok';
        row.meta = [fmtMs(e['duration_ms'])];
        if (e['input_tokens'] != null || e['output_tokens'] != null) {
          row.meta.push(`${fmtN(e['input_tokens'])} → ${fmtN(e['output_tokens'])} tokens`);
        }
        row.title = calls.length
          ? `Model call ${e['iteration']} — decided to use ${calls.map(c => c.name).join(', ')}`
          : `Model call ${e['iteration']} — answered`;
        if (e['text']) row.text = e['text'];
        if (e['stop_reason']) row.meta.push(`stop: ${e['stop_reason']}`);
        break;
      }
      case 'model.error': {
        const row: Row = pendingModel ?? { icon: 'psychology', tone: 'error', title: '', meta: [] };
        pendingModel = null;
        row.icon = 'error';
        row.tone = 'error';
        row.title = `Model call ${e['iteration']} failed`;
        row.meta = [fmtMs(e['duration_ms'])];
        row.text = e['message'];
        break;
      }
      case 'tool.call': {
        toolCalls++;
        const args = e['args'] || {};
        const argText = Object.entries(args).map(([k, v]) => (k === 'query' || k === 'path' || k === 'url' ? quote(v) : `${k}=${quote(v)}`)).join(' ');
        const row: Row = {
          icon: toolIcon(e['tool']), tone: 'running', at: e.t_ms,
          title: `${e['tool']} ${argText}`.trim(), meta: [],
        };
        pendingTools.push(row);
        ensureTurn().rows.push(row);
        break;
      }
      case 'tool.result': {
        const row: Row = pendingTools.shift() ?? { icon: toolIcon(e['tool']), tone: 'ok', title: e['tool'], meta: [] };
        row.tone = e['ok'] ? 'ok' : 'error';
        row.meta = [e['summary'], fmtMs(e['duration_ms'])].filter(Boolean);
        const items = (e['items'] || []).filter(Boolean);
        if (items.length) row.items = items;
        break;
      }
      case 'run.end': {
        const t = ensureTurn();
        t.running = false;
        t.rows.push({
          icon: 'check_circle', tone: 'ok', at: e.t_ms,
          title: `Replied in ${fmtMs(e['duration_ms'])}`,
          meta: [`${fmtN(e['reply_chars'])} characters`],
          items: (e['sources'] || []).length ? e['sources'].map((s: string) => `Source: ${s}`) : undefined,
        });
        t.summary = `${modelCalls} model call${modelCalls === 1 ? '' : 's'} · ${toolCalls} tool call${toolCalls === 1 ? '' : 's'} · `
          + `${tokensIn.toLocaleString()} input / ${tokensOut.toLocaleString()} output tokens`;
        break;
      }
      case 'run.error': {
        const t = ensureTurn();
        t.running = false;
        t.failed = true;
        for (const r of t.rows) if (r.tone === 'running') r.tone = 'error';
        t.rows.push({ icon: 'report', tone: 'error', at: e.t_ms, title: 'The visitor was shown an apology', meta: [], text: e['message'] });
        break;
      }
    }
  }
  return blocks;
}

function toolIcon(tool: string): string {
  switch (tool) {
    case 'search_docs': return 'search';
    case 'read_topic': return 'article';
    case 'browse_structure': return 'account_tree';
    case 'read_url': return 'link';
    default: return 'build';
  }
}
