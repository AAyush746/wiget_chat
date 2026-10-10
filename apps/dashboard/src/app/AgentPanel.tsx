import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiAgentStatus, FaqEntry, PublicWebsite } from '@chatflow/types';
import {
  ApiError,
  createFaq,
  deleteFaq,
  getAiAgentStatus,
  listFaqs,
  updateFaq,
  updateWebsiteAi,
} from '../lib/api';

interface AgentPanelProps {
  website: PublicWebsite;
  onClose: () => void;
}

/**
 * The "Connect Agent" panel: connects/disconnects the automatic AI assistant
 * for one website, edits the escalation reply, and manages the FAQ knowledge
 * base the agent is allowed to answer from. Admin-only (the API enforces it).
 */
export function AgentPanel({ website, onClose }: AgentPanelProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['ai-status', website.id],
    queryFn: () => getAiAgentStatus(website.id),
    retry: false,
  });

  const status = statusQuery.data;

  const invalidateWebsite = (updated: PublicWebsite) => {
    queryClient.setQueryData<AiAgentStatus>(['ai-status', website.id], (prev) =>
      prev
        ? {
            ...prev,
            aiEnabled: updated.aiEnabled,
            aiFallbackMessage: updated.aiFallbackMessage,
          }
        : prev,
    );
    queryClient.invalidateQueries({ queryKey: ['websites'] });
  };

  const connect = useMutation({
    mutationFn: (enabled: boolean) => updateWebsiteAi(website.id, { aiEnabled: enabled }),
    onSuccess: (updated) => {
      setError(null);
      invalidateWebsite(updated);
    },
    onError: (err) => setError(agentErrorMessage(err)),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/30"
      role="dialog"
      aria-label="AI Agent"
    >
      <div className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">AI Agent</h2>
            <p className="text-xs text-slate-500">
              {website.name} · {website.domain}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close AI agent panel"
            className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
          >
            ✕
          </button>
        </header>

        {error && (
          <p
            role="alert"
            className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-xs text-rose-600"
          >
            {error}
          </p>
        )}

        {statusQuery.isLoading ? (
          <p className="p-4 text-sm text-slate-500">Loading agent status…</p>
        ) : statusQuery.isError ? (
          <p role="alert" className="p-4 text-sm text-rose-600">
            {agentErrorMessage(statusQuery.error)}
          </p>
        ) : status ? (
          <>
            <ConnectionStatus
              status={status}
              busy={connect.isPending}
              onToggle={() => connect.mutate(!status.aiEnabled)}
            />
            <FallbackEditor websiteId={website.id} status={status} onError={setError} />
            <KnowledgeBase websiteId={website.id} onError={setError} />
            <Limitations />
          </>
        ) : null}
      </div>
    </div>
  );
}

function ConnectionStatus({
  status,
  busy,
  onToggle,
}: {
  status: AiAgentStatus;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="border-b border-slate-200 px-4 py-4" aria-label="Agent connection">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-2.5 rounded-full ${status.aiEnabled ? 'bg-emerald-500' : 'bg-slate-300'}`}
          />
          <span className="text-sm font-medium text-slate-800">
            {status.aiEnabled ? 'Connected' : 'Not connected'}
          </span>
        </div>
        <button
          type="button"
          disabled={busy || (!status.aiEnabled && !status.ready)}
          onClick={onToggle}
          className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 ${
            status.aiEnabled
              ? 'bg-slate-700 hover:bg-slate-600'
              : 'bg-indigo-600 hover:bg-indigo-500'
          }`}
        >
          {busy ? 'Working…' : status.aiEnabled ? 'Disconnect agent' : 'Connect agent'}
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-slate-400">Model</dt>
        <dd className="text-slate-600">
          {status.provider} · {status.model}
        </dd>
        <dt className="text-slate-400">Backend</dt>
        <dd className="text-slate-600">{status.description}</dd>
      </dl>

      {!status.ready && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
          No API key configured for the <strong>{status.provider}</strong> provider. Set{' '}
          <code>GROQ_API_KEY</code> in the API environment to use the free Groq model; until then
          the agent uses offline replies.
        </p>
      )}
    </section>
  );
}

function FallbackEditor({
  websiteId,
  status,
  onError,
}: {
  websiteId: string;
  status: AiAgentStatus;
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(status.aiFallbackMessage ?? '');

  useEffect(() => {
    setText(status.aiFallbackMessage ?? '');
  }, [status.aiFallbackMessage]);

  const dirty = (status.aiFallbackMessage ?? '') !== text;

  const save = useMutation({
    mutationFn: () => updateWebsiteAi(websiteId, { aiFallbackMessage: text.trim() || null }),
    onSuccess: (updated) => {
      onError(null);
      queryClient.setQueryData<AiAgentStatus>(['ai-status', websiteId], (prev) =>
        prev ? { ...prev, aiFallbackMessage: updated.aiFallbackMessage } : prev,
      );
      queryClient.invalidateQueries({ queryKey: ['websites'] });
    },
    onError: (err) => onError(agentErrorMessage(err)),
  });

  return (
    <section className="border-b border-slate-200 px-4 py-4" aria-label="Escalation reply settings">
      <label htmlFor="ai-fallback" className="text-sm font-medium text-slate-800">
        Escalation reply
      </label>
      <p className="mt-0.5 text-xs text-slate-500">
        Posted when a question falls outside the knowledge base and the chat is handed to a human.
      </p>
      <textarea
        id="ai-fallback"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="Thanks for your message! A member of our team will be with you shortly."
        className="mt-2 block w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
      />
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {save.isPending ? 'Saving…' : 'Save reply'}
        </button>
      </div>
    </section>
  );
}

function KnowledgeBase({
  websiteId,
  onError,
}: {
  websiteId: string;
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const faqsQuery = useQuery({
    queryKey: ['faqs', websiteId],
    queryFn: () => listFaqs(websiteId),
  });

  const reset = () => {
    setQuestion('');
    setAnswer('');
    setEditingId(null);
  };

  const save = useMutation({
    mutationFn: () =>
      editingId
        ? updateFaq(websiteId, editingId, { question: question.trim(), answer: answer.trim() })
        : createFaq(websiteId, { question: question.trim(), answer: answer.trim() }),
    onSuccess: () => {
      onError(null);
      reset();
      queryClient.invalidateQueries({ queryKey: ['faqs', websiteId] });
    },
    onError: (err) => onError(agentErrorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (faqId: string) => deleteFaq(websiteId, faqId),
    onSuccess: () => {
      onError(null);
      queryClient.invalidateQueries({ queryKey: ['faqs', websiteId] });
    },
    onError: (err) => onError(agentErrorMessage(err)),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim() || !answer.trim()) return;
    save.mutate();
  };

  const startEdit = (faq: FaqEntry) => {
    setEditingId(faq.id);
    setQuestion(faq.question);
    setAnswer(faq.answer);
  };

  const faqs = faqsQuery.data ?? [];

  return (
    <section className="border-b border-slate-200 px-4 py-4" aria-label="Knowledge base">
      <h3 className="text-sm font-medium text-slate-800">Knowledge base</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        The only product knowledge the agent may answer from.
      </p>

      {faqsQuery.isLoading ? (
        <p className="mt-2 text-xs text-slate-400">Loading FAQs…</p>
      ) : faqs.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">No FAQs yet. Add one below.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {faqs.map((faq) => (
            <li key={faq.id} className="rounded-md border border-slate-200 p-2">
              <p className="text-sm font-medium text-slate-800">{faq.question}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-500">{faq.answer}</p>
              <div className="mt-1.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => startEdit(faq)}
                  className="text-xs font-medium text-indigo-600 hover:underline"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(faq.id)}
                  className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-40"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onSubmit} className="mt-3 space-y-2">
        <input
          aria-label="FAQ question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={500}
          placeholder="Question"
          className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <textarea
          aria-label="FAQ answer"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="Answer"
          className="block w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <div className="flex justify-end gap-2">
          {editingId && (
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={save.isPending || !question.trim() || !answer.trim()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {save.isPending ? 'Saving…' : editingId ? 'Update FAQ' : 'Add FAQ'}
          </button>
        </div>
      </form>
    </section>
  );
}

function Limitations() {
  return (
    <section className="px-4 py-4" aria-label="Agent limitations">
      <h3 className="text-sm font-medium text-slate-800">What the agent can and cannot do</h3>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-slate-500">
        <li>
          <strong>Can read:</strong> this website's FAQs, and its name and domain.
        </li>
        <li>
          <strong>Cannot read:</strong> conversations, messages, visitor details, staff accounts,
          memberships, or any other website's data.
        </li>
        <li>
          Answers only from the knowledge base above — it never invents prices, policies, or
          commitments.
        </li>
        <li>
          When it can't answer, the chat is handed off to a human and the escalation reply is
          posted.
        </li>
        <li>
          Typing a staff reply (or claiming the conversation) mutes the agent for that thread.
        </li>
      </ul>
    </section>
  );
}

function agentErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isForbidden) {
      return 'Only admins can manage the AI agent.';
    }
    return error.message;
  }
  return 'Something went wrong talking to the agent service.';
}
