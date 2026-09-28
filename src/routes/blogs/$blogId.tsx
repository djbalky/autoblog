/**
 * Autonoblog — post-create blog landing route (thin shell).
 *
 * Loads the just-created blog + owner through a createServerFn action; the
 * rendering component lives client-side in src/components/wizard/BlogLanding.tsx.
 * No server-only imports reach the client bundle.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { loadBlogLandingAction } from "../../server/rpc/wizard";
import { BlogLanding } from "../../components/wizard/BlogLanding";

export const Route = createFileRoute("/blogs/$blogId")({
  loader: async ({ params }) => {
    const { user, blog } = await loadBlogLandingAction({
      data: { blogId: Number(params.blogId) },
    });
    if (!user) throw redirect({ to: "/login" });
    if (!blog) throw redirect({ to: "/dashboard" });
    return { user, blog };
  },
  component: BlogLanding,
});
