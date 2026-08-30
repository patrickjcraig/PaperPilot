import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LivePaperPilotApp } from "@/components/live-paper-pilot-app";
import { serverSession } from "@/server/auth/session";
import { readerPdfJsEnabled } from "@/server/documents/reader-pdf-config";
import { workspaceBootstrap } from "@/server/workspaces/service";

export const metadata: Metadata = {
  title: "Live workspace — PaperPilot",
  description: "A durable, authenticated PaperPilot research workspace.",
};

export const dynamic = "force-dynamic";

export default async function LiveWorkspacePage() {
  const session = await serverSession();
  if (!session) redirect("/sign-in");

  const bootstrap = await workspaceBootstrap(
    { id: session.user.id, name: session.user.name },
    session.session.activeOrganizationId,
  );

  return (
    <LivePaperPilotApp
      initialBootstrap={bootstrap}
      readerPdfJsEnabled={readerPdfJsEnabled()}
      user={{ name: session.user.name, email: session.user.email }}
    />
  );
}
