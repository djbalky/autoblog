/**
 * Autonoblog — the honest AI-provider banner (Phase 6a).
 *
 * Shown on the automation and jobs screens. It renders exactly what
 * `getModelProviderState()` reported on the server: with no text-model key it
 * says NOT CONFIGURED and names the env var to set; with a key it says which
 * provider is present. It never claims a model is usable when it is not.
 */
import type { ModelProviderState } from "../../server/ai/modelProvider";

export function ProviderBanner({ provider }: { provider: ModelProviderState }) {
  if (provider.configured) {
    return (
      <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
        <p className="text-sm font-semibold text-emerald-800">
          AI provider configured — {provider.provider} ({provider.envVar})
        </p>
        <p className="mt-1 text-xs text-emerald-700">
          A model key is present. The agent runner that calls it ships in Phase 6b; until then jobs
          stay in <span className="font-mono">queued</span> and no content is generated.
        </p>
      </div>
    );
  }
  return (
    <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
      <p className="text-sm font-semibold text-amber-900">
        NOT CONFIGURED — AI provider not configured, jobs cannot run yet
      </p>
      <p className="mt-1 text-xs text-amber-800">
        No text-model key is set in the environment. Set{" "}
        <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[11px]">
          {provider.requiredEnvVar}
        </code>{" "}
        (or one of{" "}
        <span className="font-mono text-[11px]">{provider.candidates.slice(1).join(", ")}</span>) and
        restart the site. Until then the scheduler enqueues nothing and every job stays queued.
      </p>
    </div>
  );
}
