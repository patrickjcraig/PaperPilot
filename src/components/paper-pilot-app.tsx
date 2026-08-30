"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getFiguresForPaper,
  getHighlightsForPaper,
  getPaperById,
  getSectionsForPaper,
  guidedPrompts,
  paperHighlights,
  papers,
  researchGoal,
  selectedPaper,
  selectedPaperId,
} from "@/lib/data";
import type {
  LiteratureSearchHit,
  LiteratureSearchRequest,
  LiteratureSearchResponse,
} from "@/lib/integrations";
import type {
  ReceivedWorkspaceInvitationsDto,
  WorkspaceCollaboratorsDto,
  WorkspaceDirectoryDto,
} from "@/lib/workspace";
import type { InvitableWorkspaceRole } from "@/lib/workspace-roles";
import type {
  Collection,
  EvidenceNote,
  GuidedReadingPrompt,
  InboxEntry,
  Paper,
  PaperHighlight,
  Provenance,
  ResearchProject,
  SourceLocator,
} from "@/lib/types";
import {
  createInitialWorkspaceSnapshot,
  findPaperDuplicate,
  loadWorkspaceSnapshot,
  makeId,
  saveWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "@/lib/workspace-store";
import { AppShell, type AppView } from "./app-shell";
import { CollaboratorsView } from "./collaborators-view";
import { CollectionPicker } from "./collection-picker";
import type { CollectionDraft } from "./collection-create-dialog";
import { CollectionsView } from "./collections-view";
import { DiscoverView } from "./discover-view";
import { InboxView } from "./inbox-view";
import { NotesView, type NoteDraft } from "./notes-view";
import { PaperImportDialog } from "./paper-import-dialog";
import { ProjectCreateDialog, type ProjectDraft } from "./project-create-dialog";
import { ProjectView } from "./project-view";
import { ReaderView } from "./reader-view";
import { SourcesView } from "./sources-view";
import { ToastRegion, type ToastMessage } from "./toast";
import { WorkspaceView } from "./workspace-view";
import type { WorkspaceActionResult } from "./workspace-action";

const validViews: AppView[] = [
  "discover",
  "workspace",
  "collaboration",
  "inbox",
  "sources",
  "project",
  "reader",
  "notes",
  "collections",
];
const LEGACY_ACTIVE_PROJECT_STORAGE_KEY = "paperpilot:active-project:v2";
const DEMO_METHODS_WORKSPACE_ID = "workspace:methods-lab";
const DEMO_PERSONAL_WORKSPACE_ID = "workspace:personal-desk";

const DEMO_COLLABORATION_DIRECTORY: WorkspaceDirectoryDto = {
  schemaVersion: 1,
  activeWorkspaceId: DEMO_METHODS_WORKSPACE_ID,
  workspaces: [
    {
      id: DEMO_METHODS_WORKSPACE_ID,
      name: "Methods Synthesis Lab",
      kind: "shared",
      role: "owner",
      memberCount: 3,
    },
    {
      id: DEMO_PERSONAL_WORKSPACE_ID,
      name: "Personal research desk",
      kind: "personal",
      role: "owner",
      memberCount: 1,
    },
  ],
};

const DEMO_RECEIVED_INVITATIONS: ReceivedWorkspaceInvitationsDto = {
  schemaVersion: 1,
  invitations: [{
    id: "invitation:replication-group",
    workspace: { id: "workspace:replication-group", name: "Open Replication Group" },
    inviter: { name: "Amina Chen" },
    role: "member",
    createdAt: "2026-08-28T14:20:00.000Z",
    expiresAt: "2026-09-04T14:20:00.000Z",
  }],
};

const DEMO_COLLABORATOR_REGISTERS: Record<string, WorkspaceCollaboratorsDto> = {
  [DEMO_METHODS_WORKSPACE_ID]: {
    schemaVersion: 1,
    workspaceId: DEMO_METHODS_WORKSPACE_ID,
    aggregateVersion: 12,
    currentRole: "owner",
    capabilities: {
      inviteRoles: ["admin", "member", "viewer"],
      canManageMembers: true,
    },
    members: [
      {
        id: "member:pat",
        name: "Pat Researcher",
        email: "pat@example.test",
        emailVerified: true,
        role: "owner",
        joinedAt: "2026-07-16T13:00:00.000Z",
        isCurrentUser: true,
      },
      {
        id: "member:amina",
        name: "Amina Chen",
        email: "amina@example.test",
        emailVerified: true,
        role: "admin",
        joinedAt: "2026-07-22T15:45:00.000Z",
        isCurrentUser: false,
      },
      {
        id: "member:eli",
        name: "Eli Navarro",
        email: "eli@example.test",
        emailVerified: true,
        role: "viewer",
        joinedAt: "2026-08-04T09:30:00.000Z",
        isCurrentUser: false,
      },
    ],
    pendingInvitations: [{
      id: "invitation:mina",
      email: "mina@example.test",
      role: "member",
      createdAt: "2026-08-27T16:00:00.000Z",
      expiresAt: "2026-09-03T16:00:00.000Z",
    }],
  },
  [DEMO_PERSONAL_WORKSPACE_ID]: {
    schemaVersion: 1,
    workspaceId: DEMO_PERSONAL_WORKSPACE_ID,
    aggregateVersion: 1,
    currentRole: "owner",
    capabilities: {
      inviteRoles: ["admin", "member", "viewer"],
      canManageMembers: true,
    },
    members: [{
      id: "member:pat-personal",
      name: "Pat Researcher",
      email: "pat@example.test",
      emailVerified: true,
      role: "owner",
      joinedAt: "2026-07-16T13:00:00.000Z",
      isCurrentUser: true,
    }],
    pendingInvitations: [],
  },
};

function makeProvenance(paperId: string, locator?: SourceLocator, excerpt?: string): Provenance {
  const paper = getPaperById(paperId) ?? selectedPaper;
  return {
    id: "prov-local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    sourceType: locator?.figureId ? "figure" : "paper",
    sourceId: paper.id,
    sourceTitle: paper.title,
    sourceUrl: paper.sourceUrl,
    providerName: "PaperPilot local workspace",
    retrievedAt: new Date().toISOString(),
    accessMethod: "manual",
    locator,
    excerpt,
    version: "session-draft",
  };
}

function routeFromLocation(): AppView {
  const rawView = window.location.hash.slice(1);
  if (rawView === "dashboard") return "workspace";
  if (rawView === "evidence") return "notes";
  return validViews.includes(rawView as AppView) ? rawView as AppView : "discover";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function PaperPilotApp() {
  const [activeView, setActiveView] = useState<AppView>("discover");
  const [currentPaperId, setCurrentPaperId] = useState(selectedPaperId);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(() => createInitialWorkspaceSnapshot());
  const [collaborationDirectory, setCollaborationDirectory] = useState<WorkspaceDirectoryDto>(
    DEMO_COLLABORATION_DIRECTORY,
  );
  const [collaborationInvitations, setCollaborationInvitations] = useState<ReceivedWorkspaceInvitationsDto>(
    DEMO_RECEIVED_INVITATIONS,
  );
  const [collaborationRegisters, setCollaborationRegisters] = useState<
    Record<string, WorkspaceCollaboratorsDto>
  >(DEMO_COLLABORATOR_REGISTERS);
  const notes = workspace.notes;
  const collections = workspace.collections;
  const [selectedCollectionId, setSelectedCollectionId] = useState(
    createInitialWorkspaceSnapshot().collections[0]?.id ?? "",
  );
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState(
    createInitialWorkspaceSnapshot().activeProjectId,
  );
  const [pickerPaperId, setPickerPaperId] = useState<string>();
  const [importHit, setImportHit] = useState<LiteratureSearchHit>();
  const [showProjectDialog, setShowProjectDialog] = useState(false);
  const [targetLocator, setTargetLocator] = useState<SourceLocator>();
  const [readingPromptIndex, setReadingPromptIndex] = useState(1);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastCounter = useRef(0);

  const allPapers = useMemo(() => {
    const byId = new Map<string, Paper>();
    papers.forEach((paper) => byId.set(paper.id, paper));
    workspace.importedPapers.forEach((paper) => byId.set(paper.id, paper));
    workspace.inboxEntries.forEach((entry) => {
      if (!byId.has(entry.paper.id)) byId.set(entry.paper.id, entry.paper);
    });
    return [...byId.values()];
  }, [workspace.importedPapers, workspace.inboxEntries]);

  const activeProject = workspace.projects.find((project) => project.id === activeProjectId)
    ?? workspace.projects[0];
  const currentPaper = allPapers.find((paper) => paper.id === currentPaperId) ?? selectedPaper;
  const activeProjectPapers = activeProject
    ? activeProject.paperIds
        .map((paperId) => allPapers.find((paper) => paper.id === paperId))
        .filter((paper): paper is Paper => Boolean(paper))
    : [];
  const activeProjectNotes = activeProject
    ? activeProject.evidenceNoteIds
        .map((noteId) => notes.find((note) => note.id === noteId))
        .filter((note): note is EvidenceNote => Boolean(note))
    : [];
  const activeProjectCollections = activeProject
    ? activeProject.collectionIds
        .map((collectionId) => collections.find((collection) => collection.id === collectionId))
        .filter((collection): collection is Collection => Boolean(collection))
    : [];
  const currentProjectPaperId = activeProjectPapers.some((paper) => paper.id === currentPaper.id)
    ? currentPaper.id
    : activeProjectPapers[0]?.id ?? "";
  const sections = useMemo(() => getSectionsForPaper(currentPaper.id), [currentPaper.id]);
  const figures = useMemo(() => getFiguresForPaper(currentPaper.id), [currentPaper.id]);
  const highlights = useMemo(() => getHighlightsForPaper(currentPaper.id), [currentPaper.id]);
  const pickerPaper = pickerPaperId ? allPapers.find((paper) => paper.id === pickerPaperId) : undefined;
  const importDuplicate = importHit
    ? findPaperDuplicate(importHit.paper, [...papers, ...workspace.importedPapers])
    : undefined;
  const actionableInboxCount = workspace.inboxEntries.filter((entry) =>
    entry.status !== "ready" && entry.status !== "processing",
  ).length;
  const activeCollaborationRegister = collaborationDirectory.activeWorkspaceId
    ? collaborationRegisters[collaborationDirectory.activeWorkspaceId] ?? null
    : null;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const snapshot = loadWorkspaceSnapshot(window.localStorage);
      let persistedProjectId = snapshot.activeProjectId;
      try {
        const legacyProjectId = window.localStorage.getItem(LEGACY_ACTIVE_PROJECT_STORAGE_KEY);
        if (snapshot.projects.some((project) => project.id === legacyProjectId)) {
          persistedProjectId = legacyProjectId ?? snapshot.activeProjectId;
        }
      } catch {
        // Fall back to the first restored project when browser storage is unavailable.
      }
      snapshot.activeProjectId = persistedProjectId;
      setWorkspace(snapshot);
      setActiveProjectId(persistedProjectId);
      setWorkspaceReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!workspaceReady) return;
    try {
      saveWorkspaceSnapshot(window.localStorage, workspace);
    } catch {
      // The current interaction remains usable when browser storage is unavailable.
    }
  }, [workspace, workspaceReady]);

  useEffect(() => {
    function syncRoute() {
      setActiveView(routeFromLocation());
    }
    const frame = window.requestAnimationFrame(() => {
      const view = routeFromLocation();
      setActiveView(view);
      if (!window.location.hash) window.history.replaceState(null, "", "#discover");
    });
    window.addEventListener("hashchange", syncRoute);
    window.addEventListener("popstate", syncRoute);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", syncRoute);
      window.removeEventListener("popstate", syncRoute);
    };
  }, []);

  useEffect(() => {
    const labels: Record<AppView, string> = {
      discover: "Discover",
      workspace: "Workspace",
      collaboration: "People",
      inbox: "Research Inbox",
      sources: "Sources",
      project: activeProject?.name ?? "Project",
      reader: "Paper reader",
      notes: "Evidence",
      collections: "Collections",
    };
    document.title = labels[activeView] + " — PaperPilot";
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeProject?.name, activeView]);

  useEffect(() => {
    if (!pickerPaperId) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setPickerPaperId(undefined);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [pickerPaperId]);

  function showToast(title: string, detail: string) {
    const id = ++toastCounter.current;
    setToasts((current) => [...current, { id, title, detail }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3400);
  }

  function updateDemoCollaborationRegister(
    update: (register: WorkspaceCollaboratorsDto) => WorkspaceCollaboratorsDto,
  ) {
    const workspaceId = collaborationDirectory.activeWorkspaceId;
    if (!workspaceId) return;
    setCollaborationRegisters((current) => {
      const register = current[workspaceId];
      if (!register) return current;
      return { ...current, [workspaceId]: update(register) };
    });
  }

  function switchDemoWorkspace(workspaceId: string) {
    setCollaborationDirectory((current) => ({
      ...current,
      activeWorkspaceId: current.workspaces.some((workspaceItem) => workspaceItem.id === workspaceId)
        ? workspaceId
        : current.activeWorkspaceId,
    }));
  }

  function inviteDemoCollaborator(email: string, role: InvitableWorkspaceRole) {
    const normalizedEmail = email.trim().toLowerCase();
    const now = new Date();
    const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
    updateDemoCollaborationRegister((register) => ({
      ...register,
      aggregateVersion: register.aggregateVersion + 1,
      pendingInvitations: [{
        id: makeId("invitation"),
        email: normalizedEmail,
        role,
        createdAt: now.toISOString(),
        expiresAt: expires.toISOString(),
      }, ...register.pendingInvitations],
    }));
  }

  function cancelDemoInvitation(invitationId: string) {
    updateDemoCollaborationRegister((register) => ({
      ...register,
      aggregateVersion: register.aggregateVersion + 1,
      pendingInvitations: register.pendingInvitations.filter(
        (invitation) => invitation.id !== invitationId,
      ),
    }));
  }

  function changeDemoMemberRole(memberId: string, role: InvitableWorkspaceRole) {
    updateDemoCollaborationRegister((register) => ({
      ...register,
      aggregateVersion: register.aggregateVersion + 1,
      members: register.members.map((member) => (
        member.id === memberId ? { ...member, role } : member
      )),
    }));
  }

  function removeDemoMember(memberId: string) {
    const workspaceId = collaborationDirectory.activeWorkspaceId;
    updateDemoCollaborationRegister((register) => ({
      ...register,
      aggregateVersion: register.aggregateVersion + 1,
      members: register.members.filter((member) => member.id !== memberId),
    }));
    if (workspaceId) {
      setCollaborationDirectory((current) => ({
        ...current,
        workspaces: current.workspaces.map((workspaceItem) => (
          workspaceItem.id === workspaceId
            ? { ...workspaceItem, memberCount: Math.max(1, workspaceItem.memberCount - 1) }
            : workspaceItem
        )),
      }));
    }
  }

  function decideDemoInvitation(invitationId: string, decision: "accept" | "reject") {
    const invitation = collaborationInvitations.invitations.find(
      (candidate) => candidate.id === invitationId,
    );
    if (!invitation) return;
    setCollaborationInvitations((current) => ({
      ...current,
      invitations: current.invitations.filter((candidate) => candidate.id !== invitationId),
    }));
    if (decision === "reject") return;

    const canManage = invitation.role === "admin";
    const register: WorkspaceCollaboratorsDto = {
      schemaVersion: 1,
      workspaceId: invitation.workspace.id,
      aggregateVersion: 1,
      currentRole: invitation.role,
      capabilities: {
        inviteRoles: canManage ? ["admin", "member", "viewer"] : [],
        canManageMembers: canManage,
      },
      members: [
        {
          id: `member:${invitation.workspace.id}:owner`,
          name: invitation.inviter.name,
          email: "lead@replication.example",
          emailVerified: true,
          role: "owner",
          joinedAt: invitation.createdAt,
          isCurrentUser: false,
        },
        {
          id: `member:${invitation.workspace.id}:current`,
          name: "Pat Researcher",
          email: "pat@example.test",
          emailVerified: true,
          role: invitation.role,
          joinedAt: new Date().toISOString(),
          isCurrentUser: true,
        },
      ],
      pendingInvitations: [],
    };
    setCollaborationRegisters((current) => ({
      ...current,
      [invitation.workspace.id]: register,
    }));
    setCollaborationDirectory((current) => ({
      schemaVersion: 1,
      activeWorkspaceId: invitation.workspace.id,
      workspaces: current.workspaces.some((workspaceItem) => (
        workspaceItem.id === invitation.workspace.id
      ))
        ? current.workspaces
        : [{
            id: invitation.workspace.id,
            name: invitation.workspace.name,
            kind: "shared",
            role: invitation.role,
            memberCount: 2,
          }, ...current.workspaces],
    }));
  }

  function navigate(view: AppView) {
    setActiveView(view);
    const nextHash = "#" + view;
    if (window.location.hash !== nextHash) window.history.pushState(null, "", nextHash);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }

  function selectProject(projectId: string) {
    setActiveProjectId(projectId);
    setWorkspace((current) => ({ ...current, activeProjectId: projectId }));
  }

  function openPaper(paperId: string) {
    const paper = allPapers.find((candidate) => candidate.id === paperId);
    if (!paper) {
      showToast("Paper unavailable", "The workspace could not resolve this paper record.");
      return;
    }
    if (!getSectionsForPaper(paperId).length) {
      showToast(
        "Metadata saved",
        "Full text has not been processed for this paper yet. Use its source link while the reader pipeline is added.",
      );
      return;
    }
    setCurrentPaperId(paperId);
    setTargetLocator(undefined);
    navigate("reader");
  }

  async function searchLiterature(request: LiteratureSearchRequest): Promise<LiteratureSearchResponse> {
    const response = await fetch("/api/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const errorPayload = isObject(payload) && isObject(payload.error)
        ? payload.error
        : payload;
      const message = isObject(errorPayload) && typeof errorPayload.message === "string"
        ? errorPayload.message
        : "The live literature gateway could not complete this search.";
      throw new Error(message);
    }
    if (!isObject(payload) || !Array.isArray(payload.results)) {
      throw new Error("The literature gateway returned an invalid response.");
    }
    return payload as unknown as LiteratureSearchResponse;
  }

  function commitImport(destinationProjectId?: string) {
    if (!importHit) return;
    const now = new Date().toISOString();
    const duplicate = findPaperDuplicate(importHit.paper, [...papers, ...workspace.importedPapers]);
    const canonicalPaper = duplicate ?? importHit.paper;
    const existingEntry = workspace.inboxEntries.find((entry) =>
      entry.provenance.providerName === importHit.provenance.providerName
      && entry.provenance.sourceId === importHit.provenance.sourceId,
    );
    const nextEntry: InboxEntry = {
      id: existingEntry?.id ?? makeId("inbox"),
      sourceKind: "discover",
      paper: importHit.paper,
      provenance: importHit.provenance,
      status: destinationProjectId
        ? "ready"
        : duplicate
          ? "possible-duplicate"
          : "awaiting-review",
      duplicateOfPaperId: duplicate?.id,
      destinationProjectId,
      createdAt: existingEntry?.createdAt ?? now,
      updatedAt: now,
    };

    setWorkspace((current) => {
      const knownCanonical = current.importedPapers.some((paper) => paper.id === canonicalPaper.id);
      const importedPapers = destinationProjectId && !knownCanonical
        ? [...current.importedPapers, canonicalPaper]
        : current.importedPapers;
      const inboxEntries = existingEntry
        ? current.inboxEntries.map((entry) => entry.id === existingEntry.id ? nextEntry : entry)
        : [nextEntry, ...current.inboxEntries];
      const projects = destinationProjectId
        ? current.projects.map((project) =>
            project.id === destinationProjectId
              ? {
                  ...project,
                  paperIds: project.paperIds.includes(canonicalPaper.id)
                    ? project.paperIds
                    : [...project.paperIds, canonicalPaper.id],
                  updatedAt: now,
                }
              : project)
        : current.projects;
      return { ...current, importedPapers, inboxEntries, projects };
    });

    if (destinationProjectId) {
      const destination = workspace.projects.find((project) => project.id === destinationProjectId);
      selectProject(destinationProjectId);
      showToast("Paper saved", "Added " + canonicalPaper.shortTitle + " to " + (destination?.name ?? "the project") + " with provenance.");
    } else {
      showToast("Import staged", "Added " + importHit.paper.shortTitle + " to the Research Inbox for review.");
    }
    setImportHit(undefined);
  }

  function fileInboxEntry(entryId: string, projectId: string) {
    const entry = workspace.inboxEntries.find((candidate) => candidate.id === entryId);
    const project = workspace.projects.find((candidate) => candidate.id === projectId);
    if (!entry || !project) return;
    const now = new Date().toISOString();
    const duplicate = findPaperDuplicate(entry.paper, [...papers, ...workspace.importedPapers]);
    const canonicalPaper = duplicate ?? entry.paper;

    setWorkspace((current) => ({
      ...current,
      importedPapers: current.importedPapers.some((paper) => paper.id === canonicalPaper.id)
        ? current.importedPapers
        : [...current.importedPapers, canonicalPaper],
      inboxEntries: current.inboxEntries.map((candidate) =>
        candidate.id === entryId
          ? { ...candidate, status: "ready", destinationProjectId: projectId, updatedAt: now }
          : candidate),
      projects: current.projects.map((candidate) =>
        candidate.id === projectId
          ? {
              ...candidate,
              paperIds: candidate.paperIds.includes(canonicalPaper.id)
                ? candidate.paperIds
                : [...candidate.paperIds, canonicalPaper.id],
              updatedAt: now,
            }
          : candidate),
    }));
    selectProject(projectId);
    showToast("Destination set", "Filed " + canonicalPaper.shortTitle + " in " + project.name + ".");
  }

  function createProject(draft: ProjectDraft) {
    const now = new Date().toISOString();
    const project: ResearchProject = {
      id: makeId("project"),
      name: draft.name,
      question: draft.question,
      description: "Created in PaperPilot. Add sources and papers to refine this project scope.",
      type: draft.type,
      visibility: draft.visibility,
      status: "active",
      paperIds: [],
      evidenceNoteIds: [],
      collectionIds: [],
      sourceConnectionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const nextWorkspace = {
      ...workspace,
      projects: [project, ...workspace.projects],
      activeProjectId: project.id,
    };
    setWorkspace(nextWorkspace);
    let persisted = false;
    if (workspaceReady) {
      try {
        saveWorkspaceSnapshot(window.localStorage, nextWorkspace);
        persisted = true;
      } catch {
        // Keep the new project usable in this session when browser storage is unavailable.
      }
    }
    selectProject(project.id);
    setShowProjectDialog(false);
    showToast(
      "Project created",
      persisted
        ? project.name + " is saved in this browser and ready for papers and evidence."
        : project.name + " is ready for this session, but browser storage could not save it.",
    );
    navigate("project");
  }

  function openProject(projectId: string) {
    selectProject(projectId);
    navigate("project");
  }

  function previewSource(kind: "zotero" | "crawler" | "upload") {
    const messages = {
      zotero: ["Zotero demo preview", "This browser demo does not contact Zotero. The authenticated live workspace provides the read-only OAuth connection lifecycle."],
      crawler: ["Crawler policy preview", "No crawl started. Source approval, rights review, robots checks, and rate policy come before fetching."],
      upload: ["Upload preview", "No file was uploaded. Secure object storage and isolated PDF processing are not live yet."],
    } as const;
    showToast(messages[kind][0], messages[kind][1]);
  }

  async function createCollection(draft: CollectionDraft): Promise<WorkspaceActionResult> {
    if (!activeProject) {
      return { ok: false, message: "Create or select a project before creating a collection." };
    }
    const duplicate = collections.some((collection) =>
      activeProject.collectionIds.includes(collection.id)
      && collection.name.trim().toLocaleLowerCase() === draft.name.trim().toLocaleLowerCase());
    if (duplicate) {
      return { ok: false, message: "A collection with this name already exists in this project." };
    }
    const now = new Date().toISOString();
    const collection: Collection = {
      id: makeId("collection"),
      name: draft.name.trim(),
      description: draft.description.trim(),
      color: draft.color,
      paperIds: [],
      noteIds: [],
      evidenceClaimCount: 0,
      openQuestionCount: 0,
      updatedAt: now,
    };
    setWorkspace((current) => ({
      ...current,
      collections: [collection, ...current.collections],
      projects: current.projects.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              collectionIds: [collection.id, ...project.collectionIds],
              updatedAt: now,
            }
          : project),
    }));
    setSelectedCollectionId(collection.id);
    showToast(
      "Demo collection created",
      `${collection.name} is saved only in this browser on this device.`,
    );
    return {
      ok: true,
      message: `${collection.name} was created in the browser demo.`,
    };
  }

  async function addPaperToCollection(collectionId: string, paperId: string): Promise<WorkspaceActionResult> {
    const paper = allPapers.find((candidate) => candidate.id === paperId);
    const collection = collections.find((item) => item.id === collectionId);
    if (!paper || !collection) {
      return { ok: false, message: "The browser demo could not resolve this paper or collection." };
    }
    if (collection.paperIds.includes(paperId)) {
      showToast("Already in collection", paper.shortTitle + " is already filed in " + collection.name + ".");
      return { ok: true, message: `${paper.shortTitle} is already in ${collection.name}.` };
    }
    setWorkspace((current) => ({
      ...current,
      collections: current.collections.map((item) => item.id === collectionId
        ? { ...item, paperIds: [...item.paperIds, paperId], updatedAt: new Date().toISOString() }
        : item),
    }));
    setSelectedCollectionId(collectionId);
    setPickerPaperId(undefined);
    showToast("Paper saved", "Added " + paper.shortTitle + " to " + collection.name + ".");
    return {
      ok: true,
      message: `${paper.shortTitle} was added to ${collection.name} in this browser demo.`,
    };
  }

  function addEvidenceNote(note: EvidenceNote, successTitle = "Note saved") {
    setWorkspace((current) => ({
      ...current,
      notes: [note, ...current.notes],
      collections: current.collections.map((collection) =>
        note.collectionIds.includes(collection.id)
          ? {
              ...collection,
              noteIds: collection.noteIds.includes(note.id) ? collection.noteIds : [note.id, ...collection.noteIds],
              evidenceClaimCount: note.kind === "open-question" ? collection.evidenceClaimCount : collection.evidenceClaimCount + 1,
              openQuestionCount: note.openQuestion ? collection.openQuestionCount + 1 : collection.openQuestionCount,
              updatedAt: note.updatedAt,
            }
          : collection),
      projects: current.projects.map((project) =>
        project.paperIds.includes(note.paperId) && !project.evidenceNoteIds.includes(note.id)
          ? { ...project, evidenceNoteIds: [note.id, ...project.evidenceNoteIds], updatedAt: note.updatedAt }
          : project),
    }));
    showToast(successTitle, "The record includes a source locator and provenance metadata.");
  }

  async function fileNoteInCollection(noteId: string, collectionId: string): Promise<WorkspaceActionResult> {
    const note = notes.find((item) => item.id === noteId);
    const collection = collections.find((item) => item.id === collectionId);
    if (!note || !collection) {
      return { ok: false, message: "The browser demo could not resolve this note or collection." };
    }
    if (note.collectionIds.includes(collectionId)) {
      showToast("Already filed", note.title + " is already in " + collection.name + ".");
      return { ok: true, message: `${note.title} is already in ${collection.name}.` };
    }
    const now = new Date().toISOString();
    setWorkspace((current) => ({
      ...current,
      notes: current.notes.map((item) => item.id === noteId
        ? { ...item, collectionIds: [...item.collectionIds, collectionId], updatedAt: now }
        : item),
      collections: current.collections.map((item) => item.id === collectionId
        ? {
            ...item,
            noteIds: item.noteIds.includes(noteId) ? item.noteIds : [noteId, ...item.noteIds],
            evidenceClaimCount: note.kind === "open-question" ? item.evidenceClaimCount : item.evidenceClaimCount + 1,
            openQuestionCount: note.openQuestion ? item.openQuestionCount + 1 : item.openQuestionCount,
            updatedAt: now,
          }
        : item),
    }));
    setSelectedCollectionId(collectionId);
    showToast("Note filed", "Added " + note.title + " to " + collection.name + ".");
    return {
      ok: true,
      message: `${note.title} was filed in ${collection.name} in this browser demo.`,
    };
  }

  function saveGuidedResponse(prompt: GuidedReadingPrompt, response: string, linkEvidence: boolean) {
    const now = new Date().toISOString();
    const noteId = "note-guided-" + Date.now();
    const linkedHighlights = prompt.suggestedHighlightIds
      .map((highlightId) => paperHighlights.find((highlight) => highlight.id === highlightId && highlight.paperId === currentPaper.id))
      .filter((highlight): highlight is PaperHighlight => Boolean(highlight));
    const groundedSection = getSectionsForPaper(currentPaper.id).find((section) => section.id === prompt.grounding.sectionId);
    const sourceExcerpt = linkedHighlights
      .slice(0, 2)
      .map((highlight) => highlight.provenance.excerpt ?? highlight.text)
      .join(" ")
      || groundedSection?.paragraphs[0]?.text
      || currentPaper.abstract;
    const note: EvidenceNote = {
      id: noteId,
      paperId: currentPaper.id,
      title: prompt.stageTitle + ": reader response",
      kind: linkEvidence ? "direct-evidence" : "interpretation",
      claim: response,
      evidence: linkEvidence
        ? sourceExcerpt
        : "Source link is pending; captured from the guided reader for later verification.",
      interpretation: response,
      openQuestion: linkEvidence ? undefined : "Which exact passage or figure best supports this reasoning?",
      confidence: linkEvidence ? "medium" : "low",
      status: linkEvidence ? "verified" : "captured",
      reviewedAt: linkEvidence ? now : undefined,
      provenance: makeProvenance(currentPaper.id, prompt.grounding, linkEvidence ? sourceExcerpt : undefined),
      linkedHighlightIds: linkEvidence ? prompt.suggestedHighlightIds : [],
      collectionIds: [],
      tags: ["guided reading", prompt.stageTitle.toLowerCase()],
      revision: { rootId: noteId, number: 1, isLatest: true },
      createdAt: now,
      updatedAt: now,
    };
    addEvidenceNote(note, linkEvidence ? "Evidence linked" : "Reading note saved");
  }

  function linkHighlight(highlight: PaperHighlight) {
    const now = new Date().toISOString();
    const noteId = "note-highlight-" + Date.now();
    const note: EvidenceNote = {
      id: noteId,
      paperId: highlight.paperId,
      title: highlight.marginLabel + " from page " + highlight.page,
      kind: "direct-evidence",
      claim: highlight.text,
      evidence: highlight.provenance.excerpt ?? highlight.text,
      interpretation: "Passage captured from the reader; add an interpretation before using it in the review.",
      openQuestion: "What boundary conditions should qualify this claim?",
      confidence: "medium",
      status: "captured",
      provenance: highlight.provenance,
      linkedHighlightIds: [highlight.id],
      collectionIds: [],
      tags: [highlight.role, "reader capture"],
      revision: { rootId: noteId, number: 1, isLatest: true },
      createdAt: now,
      updatedAt: now,
    };
    addEvidenceNote(note, "Passage linked");
  }

  async function addStructuredNote(draft: NoteDraft): Promise<WorkspaceActionResult> {
    const paper = allPapers.find((candidate) => candidate.id === draft.paperId);
    if (!paper) {
      return { ok: false, message: "Choose a paper in the active project before saving evidence." };
    }
    const now = new Date().toISOString();
    const noteId = "note-manual-" + Date.now();
    const sourceSection = draft.sectionId
      ? getSectionsForPaper(paper.id).find((section) => section.id === draft.sectionId)
      : undefined;
    const locator: SourceLocator = {
      paperId: paper.id,
      sectionId: sourceSection?.id,
      sectionTitle: sourceSection?.title,
      page: draft.page ? Number(draft.page) : undefined,
      figureLabel: draft.figureLabel.trim() || undefined,
    };
    const note: EvidenceNote = {
      id: noteId,
      paperId: paper.id,
      title: draft.title.trim() || draft.claim.trim().slice(0, 70),
      kind: "interpretation",
      claim: draft.claim.trim(),
      evidence: draft.evidence.trim(),
      interpretation: draft.interpretation.trim(),
      openQuestion: draft.openQuestion.trim() || undefined,
      confidence: draft.confidence,
      status: "needs-verification",
      provenance: makeProvenance(paper.id, locator, draft.evidence.trim()),
      linkedHighlightIds: [],
      collectionIds: draft.collectionId ? [draft.collectionId] : [],
      tags: ["manual note"],
      revision: { rootId: noteId, number: 1, isLatest: true },
      createdAt: now,
      updatedAt: now,
    };
    addEvidenceNote(note, "Evidence note added");
    return {
      ok: true,
      message: "Manual evidence was saved in this browser demo and marked needs verification.",
    };
  }

  function jumpToSource(paperId: string, locator?: SourceLocator) {
    if (!getSectionsForPaper(paperId).length) {
      showToast("Source location unavailable", "This metadata record has not entered the full-text reader pipeline yet.");
      return;
    }
    setCurrentPaperId(paperId);
    setTargetLocator(locator);
    navigate("reader");
  }

  if (!workspaceReady) {
    return (
      <main className="app-loading" aria-busy="true" aria-label="Loading PaperPilot workspace">
        <div className="app-loading-card" role="status">
          <span className="app-loading-mark" aria-hidden="true">P</span>
          <div>
            <strong>Opening your research workspace</strong>
            <span>Restoring projects, imports, and provenance…</span>
          </div>
        </div>
      </main>
    );
  }

  return (
    <AppShell
      activeProjectName={activeProject?.name ?? "Create a project"}
      activeView={activeView}
      collectionCount={activeProjectCollections.length}
      inboxCount={actionableInboxCount}
      noteCount={activeProjectNotes.length}
      onNavigate={navigate}
      readingProgress={currentPaper.readingProgress}
    >
      {activeView === "discover" ? (
        <DiscoverView
          goal={researchGoal}
          initialPapers={papers}
          onManageSources={() => navigate("sources")}
          onOpenPaper={openPaper}
          onSaveHit={setImportHit}
          onSearch={searchLiterature}
        />
      ) : null}

      {activeView === "workspace" ? (
        <WorkspaceView
          projects={workspace.projects}
          papers={allPapers}
          notes={notes}
          onCreateProject={() => setShowProjectDialog(true)}
          onOpenProject={openProject}
          onOpenInbox={() => navigate("inbox")}
        />
      ) : null}

      {activeView === "collaboration" ? (
        <CollaboratorsView
          collaborators={activeCollaborationRegister}
          directory={collaborationDirectory}
          invitations={collaborationInvitations}
          onAcceptInvitation={(invitationId) => decideDemoInvitation(invitationId, "accept")}
          onCancelInvitation={cancelDemoInvitation}
          onChangeRole={changeDemoMemberRole}
          onInvite={inviteDemoCollaborator}
          onRefresh={() => {
            showToast(
              "Demo register refreshed",
              "The runnable demo keeps collaboration state in this browser session.",
            );
          }}
          onRejectInvitation={(invitationId) => decideDemoInvitation(invitationId, "reject")}
          onRemoveMember={removeDemoMember}
          onSwitchWorkspace={switchDemoWorkspace}
        />
      ) : null}

      {activeView === "inbox" ? (
        <InboxView
          entries={workspace.inboxEntries}
          projects={workspace.projects}
          onChooseProject={fileInboxEntry}
          onOpenDiscover={() => navigate("discover")}
          onOpenSources={() => navigate("sources")}
        />
      ) : null}

      {activeView === "sources" ? (
        <SourcesView
          onOpenDiscover={() => navigate("discover")}
          onOpenInbox={() => navigate("inbox")}
          onPreviewSource={previewSource}
        />
      ) : null}

      {activeView === "project" && activeProject ? (
        <ProjectView
          project={activeProject}
          papers={allPapers}
          notes={notes}
          onAddPapers={() => navigate("discover")}
          onOpenPaper={openPaper}
          onBack={() => navigate("workspace")}
        />
      ) : null}

      {activeView === "reader" ? (
        <ReaderView
          key={[
            currentPaper.id,
            targetLocator?.figureId,
            targetLocator?.paragraphId,
            targetLocator?.sectionId,
          ].filter(Boolean).join("-")}
          figures={figures}
          highlights={highlights.length ? highlights : paperHighlights.filter((highlight) => highlight.paperId === currentPaper.id)}
          onBackToDiscover={() => navigate("discover")}
          onLinkHighlight={linkHighlight}
          onOpenEvidence={() => navigate("notes")}
          onSavePaper={setPickerPaperId}
          onSaveResponse={saveGuidedResponse}
          paper={currentPaper}
          promptIndex={readingPromptIndex}
          prompts={guidedPrompts}
          setPromptIndex={setReadingPromptIndex}
          sections={sections}
          targetLocator={targetLocator}
        />
      ) : null}

      {activeView === "notes" ? (
        <NotesView
          collections={activeProjectCollections}
          currentPaperId={currentProjectPaperId}
          mode="demo"
          notes={activeProjectNotes}
          onAddNote={addStructuredNote}
          onFileNote={fileNoteInCollection}
          onJumpToSource={jumpToSource}
          papers={activeProjectPapers}
        />
      ) : null}

      {activeView === "collections" ? (
        <CollectionsView
          collections={activeProjectCollections}
          currentPaperId={currentProjectPaperId}
          mode="demo"
          notes={activeProjectNotes}
          onAddPaper={addPaperToCollection}
          onCreateCollection={createCollection}
          onOpenPaper={openPaper}
          papers={activeProjectPapers}
          projectName={activeProject?.name ?? "this project"}
          selectedCollectionId={activeProjectCollections.some(
            (collection) => collection.id === selectedCollectionId,
          ) ? selectedCollectionId : activeProjectCollections[0]?.id ?? ""}
          setSelectedCollectionId={setSelectedCollectionId}
        />
      ) : null}

      {importHit ? (
        <PaperImportDialog
          duplicatePaper={importDuplicate}
          hit={importHit}
          onClose={() => setImportHit(undefined)}
          onConfirm={commitImport}
          projects={workspace.projects}
        />
      ) : null}
      {showProjectDialog ? (
        <ProjectCreateDialog
          existingProjectNames={workspace.projects.map((project) => project.name)}
          onClose={() => setShowProjectDialog(false)}
          onCreate={createProject}
        />
      ) : null}
      {pickerPaper ? (
        <CollectionPicker
          collections={activeProjectCollections}
          onAdd={addPaperToCollection}
          onClose={() => setPickerPaperId(undefined)}
          paper={pickerPaper}
        />
      ) : null}
      <ToastRegion messages={toasts} />
    </AppShell>
  );
}
