/**
 * Autonoblog — the Connections screen (Phase 6b-prep).
 *
 * The operator pastes provider credentials here instead of editing server env
 * vars. Every button is real:
 *  - Save          -> encrypts the secret and writes the `integrations` row.
 *  - Test connection -> makes the vendor's own HTTP call and stores its answer.
 *  - Disconnect    -> deletes the row.
 * The component only ever receives a masked hint (`••••1234`), never a secret,
 * and it never shows "Connected" unless a real test said so.
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  disconnectConnectionAction,
  saveConnectionAction,
  testConnectionAction,
  type ConnectionCardState,
  type ConnectionGroupState,
  type ConnectionsPageData,
} from "../../server/rpc/integrations";

const STATUS_STYLES: Record<ConnectionCardState["status"], string> = {
  connected: "border-emerald-200 bg-emerald-50 text-emerald-800",
  unverified: "border-amber-200 bg-amber-50 text-amber-800",
  error: "border-red-200 bg-red-50 text-red-700",
  env: "border-sky-200 bg-sky-50 text-sky-800",
  not_configured: "border-neutral-200 bg-neutral-100 text-neutral-600",
};

function fmtUtc(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

interface CardMessage {
  tone: "ok" | "error" | "info";
  text: string;
}

export function ConnectionsPanel({ data }: { data: ConnectionsPageData }) {
  const [groups, setGroups] = useState<ConnectionGroupState[]>(data.groups);
  const [providerState, setProviderState] = useState(data.provider);
  const [values, setValues] = useState<Record<string, Record<string, string>>>(
    () => {
      const initial: Record<string, Record<string, string>> = {};
      for (const group of data.groups) {
        for (const card of group.cards) {
          initial[card.provider] = {};
          for (const field of card.fields) {
            initial[card.provider][field.key] = field.value;
          }
        }
      }
      return initial;
    }
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, CardMessage>>({});
  const blogId = data.scopeKind === "blog" ? data.blog?.id ?? null : null;

  function replaceCard(card: ConnectionCardState) {
    setGroups((current) =>
      current.map((group) => ({
        ...group,
        cards: group.cards.map((c) => (c.provider === card.provider ? card : c)),
      }))
    );
    setValues((current) => {
      const next = { ...current };
      const entry: Record<string, string> = {};
      for (const field of card.fields) {
        // A secret is never echoed back: clear the input after a save/test.
        entry[field.key] = field.secret ? "" : field.value;
      }
      next[card.provider] = entry;
      return next;
    });
  }

  function setValue(provider: string, key: string, value: string) {
    setValues((current) => ({
      ...current,
      [provider]: { ...(current[provider] ?? {}), [key]: value },
    }));
  }

  async function save(card: ConnectionCardState) {
    setBusy(`${card.provider}:save`);
    setMessages((m) => ({ ...m, [card.provider]: { tone: "info", text: "Saving…" } }));
    const res = await saveConnectionAction({
      data: {
        blogId,
        provider: card.provider,
        values: values[card.provider] ?? {},
      },
    });
    setBusy(null);
    const saved = res.data;
    if (!res.ok || !saved) {
      setMessages((m) => ({
        ...m,
        [card.provider]: { tone: "error", text: res.error ?? "The connection could not be saved." },
      }));
      return;
    }
    replaceCard(saved.card);
    setProviderState(saved.provider);
    setMessages((m) => ({
      ...m,
      [card.provider]: {
        tone: "ok",
        text: saved.card.hasSecret
          ? `Saved and encrypted — secret ${saved.card.hint}. Test it to verify with ${card.label}.`
          : "Saved. Use Test connection to check it.",
      },
    }));
  }

  async function test(card: ConnectionCardState) {
    setBusy(`${card.provider}:test`);
    setMessages((m) => ({
      ...m,
      [card.provider]: { tone: "info", text: `Calling ${card.label}…` },
    }));
    const res = await testConnectionAction({ data: { blogId, provider: card.provider } });
    setBusy(null);
    const outcome = res.data;
    if (!res.ok || !outcome) {
      setMessages((m) => ({
        ...m,
        [card.provider]: { tone: "error", text: res.error ?? "The test could not be run." },
      }));
      return;
    }
    replaceCard(outcome.card);
    setProviderState(outcome.provider);
    setMessages((m) => ({
      ...m,
      [card.provider]: {
        tone: outcome.verified && outcome.ok ? "ok" : outcome.verified ? "error" : "info",
        text: outcome.verified ? outcome.message : `${outcome.message} (saved, not verified)`,
      },
    }));
  }

  async function disconnect(card: ConnectionCardState) {
    setBusy(`${card.provider}:disconnect`);
    const res = await disconnectConnectionAction({ data: { blogId, provider: card.provider } });
    setBusy(null);
    const removed = res.data;
    if (!res.ok || !removed) {
      setMessages((m) => ({
        ...m,
        [card.provider]: { tone: "error", text: res.error ?? "The connection could not be removed." },
      }));
      return;
    }
    replaceCard(removed.card);
    setProviderState(removed.provider);
    setMessages((m) => ({
      ...m,
      [card.provider]: { tone: "info", text: "Disconnected — the stored credential was deleted." },
    }));
  }

  const scopeLabel =
    data.scopeKind === "workspace"
      ? "Workspace connections apply to every blog you own."
      : `Connections saved here apply to "${data.blog?.name ?? "this blog"}" only and override your workspace connections for it.`;

  return (
    <main className="min-h-dvh bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
              {data.scopeKind === "workspace" ? "Workspace" : data.blog?.name ?? "Blog"}
            </p>
            <h1 className="text-lg font-bold text-neutral-900 dark:text-white">Connections</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {data.scopeKind === "blog" && data.blog ? (
              <Link
                to="/blogs/$blogId"
                params={{ blogId: String(data.blog.id) }}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200"
              >
                ← Blog
              </Link>
            ) : null}
            <Link
              to="/dashboard"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200"
            >
              Dashboard
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-8">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">{scopeLabel}</p>
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          Secrets are encrypted with AES-256-GCM before they touch the database (key source:{" "}
          <span className="font-mono">
            {data.encryptionSource === "env"
              ? "APP_ENCRYPTION_KEY"
              : data.encryptionSource === "database-url"
                ? "derived from DATABASE_URL"
                : "unavailable"}
          </span>
          ). Nothing here is ever shown back to the browser except the last four characters.
        </p>

        <div className="mt-4 rounded-lg border border-neutral-200 bg-white px-4 py-3 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          <span className="font-semibold text-neutral-700 dark:text-neutral-200">
            AI text model for automation:{" "}
          </span>
          {providerState.configured ? (
            <span className="text-emerald-700">
              {providerState.provider} — {providerState.sourceLabel}
            </span>
          ) : (
            <span className="text-amber-700">NOT CONFIGURED — connect a text model below</span>
          )}
        </div>

        {!data.canManage ? (
          <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Your role ({data.role}) is read-only here. Changing connections needs the{" "}
            <span className="font-mono">integration.manage</span> permission (owner or
            administrator).
          </div>
        ) : null}

        {groups.map((group) => (
          <section key={group.group} className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              {group.label}
            </h2>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              {group.cards.map((card) => {
                const message = messages[card.provider];
                return (
                  <article
                    key={card.provider}
                    className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">
                        {card.label}
                      </h3>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[card.status]}`}
                      >
                        {card.statusLabel}
                      </span>
                    </div>

                    {card.note ? (
                      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                        {card.note}
                      </p>
                    ) : null}

                    <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
                      Secret:{" "}
                      {card.hasSecret ? (
                        <span className="font-mono">{card.hint}</span>
                      ) : (
                        <span className="text-neutral-400">none saved</span>
                      )}
                      {card.envVar ? (
                        <span className="ml-2 text-sky-700">
                          env fallback: <span className="font-mono">{card.envVar}</span>
                        </span>
                      ) : null}
                    </p>

                    <div className="mt-3 space-y-2">
                      {card.fields.map((field) => (
                        <label key={field.key} className="block">
                          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                            {field.label}
                            {field.required ? "" : " (optional)"}
                          </span>
                          <input
                            type={field.secret ? "password" : "text"}
                            autoComplete="off"
                            spellCheck={false}
                            value={(values[card.provider] ?? {})[field.key] ?? ""}
                            onChange={(e) => setValue(card.provider, field.key, e.target.value)}
                            placeholder={
                              field.secret && card.hasSecret
                                ? `Saved (${card.hint}) — paste a new value to replace`
                                : field.placeholder
                            }
                            disabled={!data.canManage}
                            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-xs text-neutral-900 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
                          />
                        </label>
                      ))}
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => void save(card)}
                        disabled={!data.canManage || busy !== null}
                        className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
                      >
                        {busy === `${card.provider}:save` ? "Saving…" : "Save"}
                      </button>
                      <button
                        onClick={() => void test(card)}
                        disabled={!data.canManage || busy !== null || !card.hasSecret}
                        className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200"
                        title={
                          card.hasSecret
                            ? card.testable
                              ? `Call ${card.label} to verify the credential`
                              : `${card.label} has no verification endpoint — this will record "saved, not verified"`
                            : "Save a credential first"
                        }
                      >
                        {busy === `${card.provider}:test` ? "Testing…" : "Test connection"}
                      </button>
                      <button
                        onClick={() => void disconnect(card)}
                        disabled={!data.canManage || busy !== null || card.status === "not_configured"}
                        className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-40"
                      >
                        {busy === `${card.provider}:disconnect` ? "Removing…" : "Disconnect"}
                      </button>
                    </div>

                    <p className="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                      Last tested: {fmtUtc(card.lastTestedAt)}
                      {card.lastTestedAt
                        ? card.lastTestOk === true
                          ? " — accepted"
                          : card.lastTestOk === false
                            ? " — rejected"
                            : " — not verifiable"
                        : ""}
                    </p>
                    {card.lastTestMessage ? (
                      <p className="mt-1 break-words text-[11px] text-neutral-500 dark:text-neutral-400">
                        {card.lastTestMessage}
                      </p>
                    ) : null}
                    {message ? (
                      <p
                        className={`mt-2 break-words text-xs ${
                          message.tone === "ok"
                            ? "text-emerald-700"
                            : message.tone === "error"
                              ? "text-red-700"
                              : "text-neutral-600 dark:text-neutral-300"
                        }`}
                      >
                        {message.text}
                      </p>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
