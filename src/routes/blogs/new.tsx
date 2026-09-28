/**
 * Autonoblog — Phase 2 Blog Creation Wizard route (thin shell).
 *
 * Server work (auth guard + social networks snapshot) happens in the loader via
 * createServerFn actions; the full 10-step form is a client component that only
 * talks to the server through the same action layer. No server-only imports
 * reach the client bundle.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUserAction } from "../../server/rpc/auth";
import { socialNetworksAction } from "../../server/rpc/wizard";
import { BlogWizard } from "../../components/wizard/WizardForm";

export const Route = createFileRoute("/blogs/new")({
  loader: async () => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    const networks = await socialNetworksAction();
    return { user, networks };
  },
  component: BlogWizard,
});