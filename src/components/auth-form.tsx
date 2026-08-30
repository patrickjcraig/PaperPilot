"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BookOpenCheck,
  Database,
  Fingerprint,
  Link2,
  LoaderCircle,
  ShieldCheck,
  UserRoundPlus,
} from "lucide-react";
import {
  emailVerificationCallbackPath,
  invitationAwareApplicationPath,
  invitationAwareAuthPath,
  invitationIdFromApplicationUrl,
} from "@/lib/auth-flow";
import { authClient } from "@/lib/auth-client";

type AuthMode = "sign-in" | "sign-up";

interface AuthFormProps {
  mode: AuthMode;
}

const copy = {
  "sign-in": {
    eyebrow: "Authenticated workspace",
    title: "Return to the record.",
    detail:
      "Sign in to reopen your projects, source connections, and evidence trail on any device.",
    action: "Sign in",
    alternateLead: "New to PaperPilot?",
    alternateAction: "Create a workspace",
    alternateHref: "/sign-up",
  },
  "sign-up": {
    eyebrow: "Create your workspace",
    title: "Start a durable research record.",
    detail:
      "Create one account for projects, Zotero libraries, imports, and source-grounded notes.",
    action: "Create workspace",
    alternateLead: "Already have a workspace?",
    alternateAction: "Sign in",
    alternateHref: "/sign-in",
  },
} as const;

function errorMessage(error: { message?: string; code?: string } | null): string {
  if (!error) return "Authentication did not complete. Try again.";
  if (error.code === "INVALID_EMAIL_OR_PASSWORD") {
    return "The email and password do not match a PaperPilot account.";
  }
  if (
    error.code === "USER_ALREADY_EXISTS"
    || error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
  ) {
    return "PaperPilot could not create that account. Try signing in or use a different email.";
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    return "Verify this account before signing in. If delivery is available, a fresh link is on its way.";
  }
  if (error.code === "EMAIL_PASSWORD_SIGN_UP_DISABLED") {
    return "New accounts are not available on this PaperPilot deployment.";
  }
  return "Authentication did not complete. Check the details and try again.";
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const content = copy[mode];
  const isSignUp = mode === "sign-up";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [invitationId, setInvitationId] = useState<string | null>(null);
  const verificationOutcome = useRef<"error" | "verified" | null>(null);

  useEffect(() => {
    const current = new URL(window.location.href);
    const invitation = invitationIdFromApplicationUrl(current.href, current.origin);
    queueMicrotask(() => setInvitationId(invitation));
    if (mode !== "sign-in") return;
    if (!verificationOutcome.current) {
      if (current.searchParams.get("verified") !== "1") return;
      verificationOutcome.current = current.searchParams.has("error") ? "error" : "verified";
      window.history.replaceState(
        window.history.state,
        "",
        invitationAwareAuthPath("/sign-in", invitation),
      );
    }
    const outcome = verificationOutcome.current;
    queueMicrotask(() => {
      if (outcome === "error") {
        setError("This verification link is invalid or expired. Sign in to request a fresh link.");
      } else {
        setNotice("Email verified. Sign in to open your PaperPilot workspace.");
      }
    });
  }, [mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();
    const activeInvitationId = invitationIdFromApplicationUrl(
      window.location.href,
      window.location.origin,
    );

    setPending(true);
    setError(undefined);
    setNotice(undefined);

    try {
      const result = isSignUp
        ? await authClient.signUp.email({
            email,
            password,
            name,
            callbackURL: emailVerificationCallbackPath(activeInvitationId),
          })
        : await authClient.signIn.email({
            email,
            password,
            callbackURL: emailVerificationCallbackPath(activeInvitationId),
          });

      if (result.error) {
        setError(errorMessage(result.error));
        return;
      }

      if (isSignUp && !result.data?.token) {
        setNotice(
          "If this address can be registered, PaperPilot will send a verification link. "
          + "The same response is shown for existing accounts.",
        );
        return;
      }

      router.push(invitationAwareApplicationPath(activeInvitationId));
      router.refresh();
    } catch {
      setError("PaperPilot could not reach the account service. Check the server and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-shell">
      <header className="auth-masthead">
        <Link className="auth-brand" href="/" aria-label="PaperPilot demo home">
          <span className="auth-brand-mark" aria-hidden="true">P</span>
          <span>PaperPilot</span>
        </Link>
        <Link className="auth-demo-link" href="/#discover">
          Continue in local demo
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </header>

      <main className="auth-layout">
        <section className="auth-ledger" aria-labelledby="auth-ledger-title">
          <div>
            <p className="eyebrow">Research custody</p>
            <h1 id="auth-ledger-title">Evidence should outlive the browser tab.</h1>
            <p className="auth-ledger-intro">
              A live PaperPilot workspace keeps each decision attached to its paper,
              source, project, and author.
            </p>
          </div>

          <ol className="auth-custody-chain" aria-label="Authenticated evidence chain">
            <li>
              <span className="auth-chain-icon"><Fingerprint size={17} /></span>
              <div>
                <span className="auth-chain-label">Identity</span>
                <strong>One accountable researcher</strong>
                <p>Session-backed access replaces anonymous browser ownership.</p>
              </div>
            </li>
            <li>
              <span className="auth-chain-icon"><Database size={17} /></span>
              <div>
                <span className="auth-chain-label">Workspace</span>
                <strong>Durable projects and evidence</strong>
                <p>Projects, imports, notes, and collections share one protected record.</p>
              </div>
            </li>
            <li>
              <span className="auth-chain-icon"><Link2 size={17} /></span>
              <div>
                <span className="auth-chain-label">Sources</span>
                <strong>Traceable library connections</strong>
                <p>Zotero and scholarly indexes retain provider-level provenance.</p>
              </div>
            </li>
          </ol>

          <div className="auth-assurance">
            <ShieldCheck size={18} aria-hidden="true" />
            <p>
              Credentials stay on the server. Workspace access is checked again at every
              data boundary.
            </p>
          </div>
        </section>

        <section className="auth-paper" aria-labelledby="auth-form-title">
          <div className="auth-paper-running-head">
            <span>Account docket</span>
            <BookOpenCheck size={17} aria-hidden="true" />
          </div>

          <div className="auth-form-heading">
            <p className="eyebrow">{content.eyebrow}</p>
            <h2 id="auth-form-title">{content.title}</h2>
            <p>{content.detail}</p>
          </div>

          {invitationId ? (
            <div className="auth-invitation-notice" role="note">
              <UserRoundPlus size={18} aria-hidden="true" />
              <p>
                Use the invited email address. After authentication, PaperPilot will show
                the workspace invitation before any access is granted.
              </p>
            </div>
          ) : null}

          <form className="auth-form" onSubmit={submit}>
            {isSignUp ? (
              <label className="field-group">
                <span className="field-label">Name</span>
                <input
                  className="text-input"
                  name="name"
                  type="text"
                  autoComplete="name"
                  minLength={2}
                  maxLength={120}
                  required
                  disabled={pending}
                />
              </label>
            ) : null}

            <label className="field-group">
              <span className="field-label">Email</span>
              <input
                className="text-input"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                maxLength={254}
                required
                disabled={pending}
              />
            </label>

            <label className="field-group">
              <span className="field-label auth-field-label">
                <span>Password</span>
                {!isSignUp ? <Link href="/forgot-password">Forgot password?</Link> : null}
              </span>
              <input
                className="text-input"
                name="password"
                type="password"
                autoComplete={isSignUp ? "new-password" : "current-password"}
                minLength={8}
                maxLength={128}
                required
                disabled={pending}
              />
              {isSignUp ? (
                <span className="field-help">Use at least 8 characters.</span>
              ) : null}
            </label>

            {notice ? (
              <div className="auth-notice" role="status">
                {notice}
              </div>
            ) : null}

            {error ? (
              <div className="auth-error" role="alert">
                {error}
              </div>
            ) : null}

            <button className="button primary full auth-submit" type="submit" disabled={pending}>
              {pending ? <LoaderCircle className="auth-spinner" size={16} /> : null}
              {pending ? "Working…" : content.action}
            </button>
          </form>

          <p className="auth-alternate">
            {content.alternateLead}{" "}
                <Link
                  href={invitationAwareAuthPath(
                    content.alternateHref as "/sign-in" | "/sign-up",
                    invitationId,
                  )}
                >
                  {content.alternateAction}
                </Link>
          </p>

          <p className="auth-terms">
            The local demo remains device-only. Authenticated workspaces use the server data
            boundary described in PaperPilot’s deployment configuration.
          </p>
        </section>
      </main>
    </div>
  );
}
