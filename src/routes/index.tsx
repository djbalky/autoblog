import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-white px-6 text-center dark:bg-neutral-900">
      <div className="max-w-xl">
        <p className="text-sm font-semibold uppercase tracking-widest text-indigo-600 dark:text-indigo-400">
          Autonomous Blog CMS
        </p>
        <h1 className="mt-3 text-3xl font-bold text-neutral-900 dark:text-white">
          Autonoblog
        </h1>
        <p className="mt-4 text-neutral-600 dark:text-neutral-300">
          Create and operate one or more self-publishing blogs — research, write,
          optimize, publish and distribute content automatically, or keep manual
          control through a WordPress-class CMS dashboard.
        </p>
        <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
          Phase 1 foundation: persistent database, authentication with roles, and a
          real dashboard wired to the database.
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          to="/login"
          className="rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          Sign in
        </Link>
        <Link
          to="/register"
          className="rounded-md border border-neutral-300 px-5 py-2.5 text-sm font-medium text-neutral-700 dark:border-neutral-700 dark:text-neutral-200"
        >
          Create account
        </Link>
      </div>
    </main>
  );
}
