import { createFileRoute, redirect } from "@tanstack/react-router";
import { useNavigate, Link } from "@tanstack/react-router";
import { useState, FormEvent } from "react";
import { registerAction } from "../server/rpc/auth";

export const Route = createFileRoute("/register")({
  beforeLoad: async () => {
    const { currentUserAction } = await import("../server/rpc/auth");
    const { user } = await currentUserAction();
    if (user) throw redirect({ to: "/dashboard" });
  },
  component: RegisterPage,
});

function RegisterPage() {
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await registerAction({
        data: { email, password, displayName },
      });
      if (res.ok) {
        navigate({ to: "/dashboard" });
      } else {
        setError(res.error ?? "Registration failed.");
      }
    } catch (err) {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-dvh flex items-center justify-center bg-white px-6 dark:bg-neutral-900">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">
          Create your account
        </h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          You’ll start with the contributor role.
        </p>
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Display name
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Email
            </span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Password
            </span>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            />
            <span className="mt-1 block text-xs text-neutral-400">
              At least 8 characters.
            </span>
          </label>
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {submitting ? "Creating…" : "Create account"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
          Already have an account?{" "}
          <Link
            to="/login"
            className="font-medium text-neutral-900 underline dark:text-white"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
