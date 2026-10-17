/**
 * Autonoblog — /blogs/$blogId/posts/$postId : block editor route.
 *
 * `$postId` may be the literal `new`, which loads an empty editor that writes a
 * real `posts` row when the author creates the draft.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUserAction } from "../../server/rpc/auth";
import { editorLoadAction } from "../../server/rpc/posts";
import { PostEditor } from "../../components/posts/PostEditor";
import type { EditorData } from "../../server/rpc/posts";

export const Route = createFileRoute("/blogs/$blogId_/posts_/$postId")({
  loader: async ({ params }): Promise<EditorData> => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    const raw = String(params.postId);
    return editorLoadAction({
      data: {
        blogId: Number(params.blogId),
        postId: raw === "new" ? null : Number(raw),
      },
    });
  },
  component: EditorRoute,
});

function EditorRoute() {
  const data = Route.useLoaderData();
  const { postId } = Route.useParams();
  if (data.forbidden || !data.blog) {
    return (
      <main className="min-h-dvh bg-neutral-50 px-6 py-20">
        <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">403</p>
          <h1 className="mt-1 text-xl font-bold text-neutral-900">Editor unavailable</h1>
          <p className="mt-2 text-sm text-neutral-600">
            This blog either does not exist or you are not one of its members — post rows are
            filtered by blog membership in the database.
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
  if (data.post === null && String(postId) !== "new") {
    return (
      <main className="min-h-dvh bg-neutral-50 px-6 py-20">
        <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">404</p>
          <h1 className="mt-1 text-xl font-bold text-neutral-900">Post not found</h1>
          <p className="mt-2 text-sm text-neutral-600">
            This post does not exist in this blog (it may have been deleted, or it belongs to a
            different blog).
          </p>
          <a
            href={`/blogs/${data.blog.id}/posts`}
            className="mt-5 inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
          >
            Back to posts
          </a>
        </div>
      </main>
    );
  }
  return (
    <PostEditor
      blog={data.blog}
      role={data.role ?? "member"}
      post={data.post}
      revisions={data.revisions}
    />
  );
}
