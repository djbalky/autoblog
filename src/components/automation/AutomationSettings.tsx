/**
 * Autonoblog — the per-blog automation settings screen (Phase 6a).
 *
 * Everything here persists to the real `blog_automations` row through
 * `saveAutomationAction`; nothing is a local-only toggle. The screen shows the
 * defaults as defaults (`persisted: false`) until the first save, and it shows
 * the AI provider's real state — with no model key, automation cannot run and
 * the screen says so instead of pretending a job will be produced.
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { saveAutomationAction } from "../../server/rpc/automation";
import type { AutomationConfigRow } from "../../server/dal/automations";
import type { ModelProviderState } from "../../server/ai/modelProvider";
import type { AutomationWorkerState } from "../../server/scheduler";
import { ProviderBanner } from "./ProviderBanner";

/** Mirrors SOCIAL_NETWORKS in src/server/dal/automations.ts (client-safe copy). */
const NETWORKS: { id: string; label: string }[] = [
  { id: "x", label: "X (Twitter)" },
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "pinterest", label: "Pinterest" },
  { id: "telegram", label: "Telegram" },
  { id: "tiktok", label: "TikTok" },
];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function fmtUtc(value: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function fmtAge(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  return `${String(Math.floor(seconds / 3600))}h ago`;
}

export interface AutomationSettingsProps {
  blog: { id: number; name: string; slug: string };
  role: string;
  canManage: boolean;
  config: AutomationConfigRow;
  provider: ModelProviderState;
  worker: AutomationWorkerState;
  jobsToday: number;
}

interface Draft {
  enabled: boolean;
  postsPerDay: number;
  publishTimes: string[];
  topics: string[];
  language: string;
  tone: string;
  targetAudience: string;
  minWordCount: number;
  seoRequireMeta: boolean;
  seoRequireInternalLinks: boolean;
  seoKeywords: string;
  approvalMode: "manual" | "automatic";
  socialNetworks: string[];
}

export function AutomationSettings({
  blog,
  role,
  canManage,
  config,
  provider,
  worker,
  jobsToday,
}: AutomationSettingsProps) {
  const [draft, setDraft] = useState<Draft>({
    enabled: config.enabled,
    postsPerDay: config.postsPerDay,
    publishTimes: [...config.publishTimes],
    topics: [...config.topics],
    language: config.language,
    tone: config.tone,
    targetAudience: config.targetAudience,
    minWordCount: config.minWordCount,
    seoRequireMeta: config.seoRequireMeta,
    seoRequireInternalLinks: config.seoRequireInternalLinks,
    seoKeywords: config.seoKeywords,
    approvalMode: config.approvalMode,
    socialNetworks: [...config.socialNetworks],
  });
  const [saved, setSaved] = useState<AutomationConfigRow | null>(
    config.persisted ? config : null
  );
  const [topicInput, setTopicInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const patch = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));

  function addTopic() {
    const value = topicInput.trim();
    if (!value) return;
    if (draft.topics.some((t) => t.toLowerCase() === value.toLowerCase())) {
      setTopicInput("");
      return;
    }
    patch({ topics: [...draft.topics, value] });
    setTopicInput("");
  }

  function addTime() {
    const used = new Set(draft.publishTimes);
    const candidate = ["06:00", "09:00", "12:00", "15:00", "17:00", "20:00"].find(
      (t) => !used.has(t)
    );
    patch({ publishTimes: [...draft.publishTimes, candidate ?? "09:00"] });
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await saveAutomationAction({ data: { blogId: blog.id, config: draft } });
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.error ?? "The automation settings could not be saved.");
      return;
    }
    const row = res.data;
    setSaved(row);
    setDraft({
      enabled: row.enabled,
      postsPerDay: row.postsPerDay,
      publishTimes: [...row.publishTimes],
      topics: [...row.topics],
      language: row.language,
      tone: row.tone,
      targetAudience: row.targetAudience,
      minWordCount: row.minWordCount,
      seoRequireMeta: row.seoRequireMeta,
      seoRequireInternalLinks: row.seoRequireInternalLinks,
      seoKeywords: row.seoKeywords,
      approvalMode: row.approvalMode,
      socialNetworks: [...row.socialNetworks],
    });
    setNotice(`Saved to the database at ${fmtUtc(row.updatedAt)}.`);
  }

  const runNowReason = !provider.configured
    ? `AI provider not configured (${provider.requiredEnvVar} missing) — nothing can run yet.`
    : "A provider key is present, but the agent runner ships in Phase 6b — there is nothing to run yet.";

  return (
    <main className="min-h-dvh bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
              Automation
            </p>
            <h1 className="truncate text-lg font-bold text-neutral-900">{blog.name}</h1>
            <p className="truncate font-mono text-xs text-neutral-500">/{blog.slug}</p>
          </div>
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              to="/blogs/$blogId"
              params={{ blogId: String(blog.id) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-50"
            >
              ← Blog overview
            </Link>
            <Link
              to="/blogs/$blogId/posts"
              params={{ blogId: String(blog.id) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-50"
            >
              Posts
            </Link>
            <Link
              to="/blogs/$blogId/jobs"
              params={{ blogId: String(blog.id) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-50"
            >
              Jobs
            </Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-8">
        <ProviderBanner provider={provider} />

        <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-neutral-900">Automation worker</h2>
              <p className="text-xs text-neutral-500">
                The scheduler inside the site&apos;s server process checks every{" "}
                {worker.intervalSeconds}s whether a publishing slot is due.
              </p>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
                worker.running
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                  : "bg-amber-50 text-amber-800 ring-amber-600/20"
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${worker.running ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              {worker.running ? "Worker running" : "Worker not running"}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-neutral-600 sm:grid-cols-4">
            <div>
              <dt className="font-medium text-neutral-500">Last check</dt>
              <dd>
                {fmtUtc(worker.lastTickAt)}{" "}
                <span className="text-neutral-400">({fmtAge(worker.heartbeatAgeSeconds)})</span>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-500">Jobs enqueued last check</dt>
              <dd>{worker.lastEnqueued}</dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-500">Jobs today (this blog)</dt>
              <dd>
                {jobsToday} / {draft.postsPerDay}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-500">Last enqueued</dt>
              <dd>{fmtUtc(saved?.lastEnqueuedAt ?? null)}</dd>
            </div>
          </dl>
          {worker.note && (
            <p className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
              Last worker check: {worker.note}
            </p>
          )}
          {worker.lastError && (
            <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              Last worker error: {worker.lastError}
            </p>
          )}
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-neutral-900">Automation settings</h2>
              <p className="mt-1 text-xs text-neutral-500">
                {saved
                  ? `Saved in blog_automations — last write ${fmtUtc(saved.updatedAt)}.`
                  : "Nothing saved yet: these are the defaults and no blog_automations row exists."}
              </p>
            </div>
            <div className="text-right">
              <button
                type="button"
                disabled
                title={runNowReason}
                className="cursor-not-allowed rounded-md border border-neutral-300 bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-400"
              >
                Run now
              </button>
              <p className="mt-1 max-w-xs text-[11px] text-neutral-500">{runNowReason}</p>
            </div>
          </div>

          <div className="mt-6 space-y-6">
            <div className="flex items-start gap-3">
              <input
                id="enabled"
                type="checkbox"
                checked={draft.enabled}
                disabled={!canManage}
                onChange={(e) => patch({ enabled: e.target.checked })}
                className="mt-1 h-4 w-4 rounded border-neutral-300"
              />
              <label htmlFor="enabled" className="text-sm text-neutral-800">
                <span className="font-medium">Automation enabled</span>
                <span className="block text-xs text-neutral-500">
                  Off by default. When on, the scheduler enqueues a ContentJob at each publishing
                  time — but only if an AI provider is configured.
                </span>
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-neutral-800">
                <span className="font-medium">Posts per day</span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={draft.postsPerDay}
                  disabled={!canManage}
                  onChange={(e) => patch({ postsPerDay: Number(e.target.value) })}
                  className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
              <label className="text-sm text-neutral-800">
                <span className="font-medium">Minimum word count</span>
                <input
                  type="number"
                  min={100}
                  max={20000}
                  value={draft.minWordCount}
                  disabled={!canManage}
                  onChange={(e) => patch({ minWordCount: Number(e.target.value) })}
                  className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-800">
                  Publishing times (UTC, HH:MM)
                </span>
                {canManage && (
                  <button
                    type="button"
                    onClick={addTime}
                    className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
                  >
                    + Add time
                  </button>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {draft.publishTimes.length === 0 && (
                  <p className="text-xs text-neutral-500">No times yet — add at least one.</p>
                )}
                {draft.publishTimes.map((time, index) => (
                  <span key={`${time}-${String(index)}`} className="flex items-center gap-1">
                    <input
                      value={time}
                      disabled={!canManage}
                      onChange={(e) => {
                        const next = [...draft.publishTimes];
                        next[index] = e.target.value;
                        patch({ publishTimes: next });
                      }}
                      placeholder="09:00"
                      className={`w-20 rounded-md border px-2 py-1 font-mono text-sm ${
                        HHMM.test(time)
                          ? "border-neutral-300"
                          : "border-red-400 bg-red-50 text-red-700"
                      }`}
                    />
                    {canManage && (
                      <button
                        type="button"
                        onClick={() =>
                          patch({
                            publishTimes: draft.publishTimes.filter((_, i) => i !== index),
                          })
                        }
                        className="rounded border border-neutral-300 px-1.5 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
                        aria-label={`Remove ${time}`}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-neutral-500">
                One job per time slot. Times are UTC so they match the worker and the stored rows.
              </p>
            </div>

            <div>
              <span className="text-sm font-medium text-neutral-800">Topics / niches</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {draft.topics.map((topic) => (
                  <span
                    key={topic}
                    className="inline-flex items-center gap-2 rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-700"
                  >
                    {topic}
                    {canManage && (
                      <button
                        type="button"
                        onClick={() =>
                          patch({ topics: draft.topics.filter((t) => t !== topic) })
                        }
                        className="text-neutral-500 hover:text-neutral-900"
                        aria-label={`Remove ${topic}`}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                ))}
                {draft.topics.length === 0 && (
                  <p className="text-xs text-neutral-500">
                    No topics yet. The automation picks its next topic from this list.
                  </p>
                )}
              </div>
              {canManage && (
                <div className="mt-2 flex gap-2">
                  <input
                    value={topicInput}
                    onChange={(e) => setTopicInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTopic();
                      }
                    }}
                    placeholder="e.g. strength training for beginners"
                    className="w-full max-w-md rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={addTopic}
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
                  >
                    Add topic
                  </button>
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <label className="text-sm text-neutral-800">
                <span className="font-medium">Language</span>
                <input
                  value={draft.language}
                  disabled={!canManage}
                  onChange={(e) => patch({ language: e.target.value })}
                  placeholder="en"
                  className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
              <label className="text-sm text-neutral-800">
                <span className="font-medium">Tone</span>
                <input
                  value={draft.tone}
                  disabled={!canManage}
                  onChange={(e) => patch({ tone: e.target.value })}
                  placeholder="informative"
                  className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
              <label className="text-sm text-neutral-800">
                <span className="font-medium">Target audience</span>
                <input
                  value={draft.targetAudience}
                  disabled={!canManage}
                  onChange={(e) => patch({ targetAudience: e.target.value })}
                  placeholder="e.g. new gym members"
                  className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
            </div>

            <div>
              <span className="text-sm font-medium text-neutral-800">SEO requirements</span>
              <div className="mt-2 space-y-2">
                <label className="flex items-center gap-2 text-sm text-neutral-700">
                  <input
                    type="checkbox"
                    checked={draft.seoRequireMeta}
                    disabled={!canManage}
                    onChange={(e) => patch({ seoRequireMeta: e.target.checked })}
                    className="h-4 w-4 rounded border-neutral-300"
                  />
                  Require a meta description and title tag on every post
                </label>
                <label className="flex items-center gap-2 text-sm text-neutral-700">
                  <input
                    type="checkbox"
                    checked={draft.seoRequireInternalLinks}
                    disabled={!canManage}
                    onChange={(e) => patch({ seoRequireInternalLinks: e.target.checked })}
                    className="h-4 w-4 rounded border-neutral-300"
                  />
                  Require internal links to other posts in this blog
                </label>
                <label className="block text-sm text-neutral-700">
                  <span className="font-medium">Target keywords</span>
                  <input
                    value={draft.seoKeywords}
                    disabled={!canManage}
                    onChange={(e) => patch({ seoKeywords: e.target.value })}
                    placeholder="comma-separated keywords"
                    className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                  />
                </label>
              </div>
            </div>

            <div>
              <span className="text-sm font-medium text-neutral-800">Approval mode</span>
              <div className="mt-2 flex flex-wrap gap-4">
                {(
                  [
                    { id: "manual", label: "Manual review — a human publishes" },
                    { id: "automatic", label: "Automatic — publish when the pipeline finishes" },
                  ] as const
                ).map((option) => (
                  <label key={option.id} className="flex items-center gap-2 text-sm text-neutral-700">
                    <input
                      type="radio"
                      name="approvalMode"
                      checked={draft.approvalMode === option.id}
                      disabled={!canManage}
                      onChange={() => patch({ approvalMode: option.id })}
                      className="h-4 w-4"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <span className="text-sm font-medium text-neutral-800">Social networks</span>
              <p className="mt-1 text-[11px] text-neutral-500">
                Stored with the automation now; each network stays NOT CONFIGURED until it is
                connected in Phase 7.
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {NETWORKS.map((network) => {
                  const checked = draft.socialNetworks.includes(network.id);
                  return (
                    <label
                      key={network.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-700"
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!canManage}
                          onChange={(e) =>
                            patch({
                              socialNetworks: e.target.checked
                                ? [...draft.socialNetworks, network.id]
                                : draft.socialNetworks.filter((n) => n !== network.id),
                            })
                          }
                          className="h-4 w-4 rounded border-neutral-300"
                        />
                        {network.label}
                      </span>
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                        Not configured
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          {error && (
            <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          {notice && (
            <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {notice}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 pt-4">
            <p className="text-xs text-neutral-500">
              You are signed in as <b className="capitalize">{role}</b> of this blog.{" "}
              {canManage
                ? "Your role can save these settings."
                : "Only the owner or an administrator (automation.manage) can save them."}
            </p>
            <button
              type="button"
              onClick={save}
              disabled={!canManage || busy}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save settings"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
