import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { HOP_API_URL } from '@heretto/hop-ui';

export interface Appearance {
  title: string;
  subtitle: string;
  welcome_message: string;
  input_placeholder: string;
  suggested_prompts: string[];
  accent_color: string;
  position: 'right' | 'left';
  show_sources: boolean;
}

export interface ChatApp {
  id: string;
  public_id: string;
  name: string;
  description?: string | null;
  agent_id?: string | null;
  agent?: { id: string; name: string; is_active: boolean; has_ai_configuration: boolean; provider?: string | null; model?: string | null } | null;
  deploy_credential_id?: string | null;
  deploy_credential?: { id: string; name: string; organization_id: string; deployment_id: string; portal_base_url: string; audience: string } | null;
  appearance: Appearance;
  allowed_origins: string[];
  is_active: boolean;
  problems: string[];
  chat_url: string;
  embed_script_url: string;
  embed_snippet: string;
  conversation_count: number;
  created_at?: string;
  updated_at?: string | null;
  created_by?: string | null;
}

export interface ChatAppWrite {
  name?: string;
  description?: string | null;
  agent_id?: string | null;
  deploy_credential_id?: string | null;
  appearance?: Appearance;
  allowed_origins?: string[];
  is_active?: boolean;
}

export interface Source { title: string; path: string; url?: string | null; }

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: Source[];
  details: {
    error?: string;
    agent?: string;
    provider?: string;
    model?: string;
    ai_configuration?: string;
    tool_calls?: { tool: string; args?: Record<string, string>; url?: string; status?: string }[];
  };
  created_at: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  message_count: number;
  created_at: string;
  updated_at?: string | null;
  origin?: string | null;
  locale?: string | null;
  visitor: string;
}

export interface Conversation extends ConversationSummary { messages: TranscriptMessage[]; }

export const DEFAULT_APPEARANCE: Appearance = {
  title: 'Ask the docs',
  subtitle: 'Answers from our documentation',
  welcome_message: 'Hi! Ask me anything about our documentation.',
  input_placeholder: 'Ask a question…',
  suggested_prompts: [],
  accent_color: '#011627',
  position: 'right',
  show_sources: true,
};

@Injectable({ providedIn: 'root' })
export class ChatAppService {
  private http = inject(HttpClient);
  private api = `${inject(HOP_API_URL)}/chat-apps`;

  list(): Observable<ChatApp[]> { return this.http.get<ChatApp[]>(`${this.api}/`); }
  get(id: string): Observable<ChatApp> { return this.http.get<ChatApp>(`${this.api}/${id}`); }
  create(data: ChatAppWrite): Observable<ChatApp> { return this.http.post<ChatApp>(`${this.api}/`, data); }
  update(id: string, data: ChatAppWrite): Observable<ChatApp> { return this.http.put<ChatApp>(`${this.api}/${id}`, data); }
  delete(id: string): Observable<{ message: string }> { return this.http.delete<{ message: string }>(`${this.api}/${id}`); }
  rotatePublicId(id: string): Observable<ChatApp> { return this.http.post<ChatApp>(`${this.api}/${id}/rotate-public-id`, {}); }
  /** A trace token for the Test tab: the chat's replies then carry agent trace events. */
  startTestSession(id: string): Observable<{ trace_token: string; expires_in: number }> {
    return this.http.post<{ trace_token: string; expires_in: number }>(`${this.api}/${id}/test-session`, {});
  }

  conversations(id: string, offset = 0, limit = 50): Observable<{ items: ConversationSummary[]; total: number }> {
    const params = new HttpParams().set('offset', offset).set('limit', limit);
    return this.http.get<{ items: ConversationSummary[]; total: number }>(`${this.api}/${id}/conversations/`, { params });
  }
  conversation(id: string, conversationId: string): Observable<Conversation> {
    return this.http.get<Conversation>(`${this.api}/${id}/conversations/${conversationId}`);
  }
  deleteConversation(id: string, conversationId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`${this.api}/${id}/conversations/${conversationId}`);
  }
}
