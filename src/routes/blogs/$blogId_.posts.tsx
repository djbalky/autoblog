/**
 * Autonoblog — /blogs/$blogId/posts : the posts list route.
 *
 * The `$blogId_` segment keeps this route a sibling of `/blogs/$blogId` (the
 * blog overview renders its own page, not an outlet). The loader resolves the
 * session + membership server-side; a non-member gets the real 403 panel below.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUserAction } from "../../server/rpc/auth";
import { postsIndexAction } from "../../server/rpc/posts";
import { PostsList } from "../../components/posts/PostsList";
import type { PostsIndexData } from "../../server/rpc/posts";

export const Route = createFileRoute("/blogs/$blogId_/posts")({
  loader: async ({ params }): Promise<PostsIndexData & { signedIn: boolean }> => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    const data = await postsIndexAction({ data: { blogId: Number(params.blogId) } });
    return { ...data, signedIn: true };
  },
  component: PostsRoute,
});

function PostsRoute() {
  const data = Route.useLoaderData();
  if (data.forbidden || !data.blog) {
    return (
      <main className="min-h-dvh bg-neutral-50 px-6 py-20">
        <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">403</p>
          <h1 className="mt-1 text-xl font-bold text-neutral-900">Blog not available to you</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Either this blog does not exist, or you are not a member of it. Posts are scoped
            to blog members in the database, so nothing is listed here.
          </p>
          <a
            href="/dashboard"
            className="mt-5 inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
          >
            Back to dashboard
          </a>
        </div>
      </main>
    );
  }
  return (
    <PostsList
      blog={data.blog}
      role={data.role ?? "member"}
      posts={data.posts}
      counts={data.counts}
    />
  );
}
