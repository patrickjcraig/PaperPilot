"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BookOpenCheck,
  KeyRound,
  LoaderCircle,
  MailCheck,
  ShieldCheck,
} from "lucide-react";
import {
  PASSWORD_RESET_CALLBACK_PATH,
  resetLinkStateFromUrl,
  type ResetLinkState,
} from "@/lib/auth-flow";
import { authClient } from "@/lib/auth-client";

interface RecoveryFrameProps {
  eyebrow: string;
  title: string;
  detail: string;
  children: ReactNode;
}

function RecoveryFrame({ eyebrow, title, detail, children }: RecoveryFrameProps) {
  return (
    <div className="auth-shell">
      <header className="auth-masthead">
        <Link className="auth-brand" href="/" aria-label="PaperPilot demo home">
          <span className="auth-brand-mark" aria-hidden="true">P</span>
          <span>PaperPilot</span>
        </Link>
        <Link className="auth-demo-link" href="/sign-in">
          <ArrowLeft size={14} aria-hidden="true" />
          Back to sign in
        </Link>
      </header>

      <main className="auth-layout">
        <section className="auth-ledger" aria-labelledby="recovery-ledger-title">
          <div>
            <p className="eyebrow">Account recovery</p>
            <h1 id="recovery-ledger-title">A reset should leave no loose ends.</h1>
            <p className="auth-ledger-intro">
              PaperPilot uses short-lived, one-time links and gives every email address the
              same response. Reset links are removed from browser history as soon as they open.
            </p>
          </div>

          <ol className="auth-custody-chain" aria-label="Password recovery safeguards">
            <li>
              <span className="auth-chain-icon"><MailCheck size={17} /></span>
              <div>
                <span className="auth-chain-label">Request</span>
                <strong>One neutral response</strong>
                <p>The form never confirms whether an address belongs to an account.</p>
              </div>
            </li>
            <li>
              <span className="auth-chain-icon"><KeyRound size={17} /></span>
              <div>
                <span className="auth-chain-label">Reset</span>
                <strong>One-time credential</strong>
                <p>A valid recovery token can change the password only once.</p>
              </div>
            </li>
            <li>
              <span className="auth-chain-icon"><ShieldCheck size={17} /></span>
              <div>
                <span className="auth-chain-label">Sessions</span>
                <strong>Existing access revoked</strong>
                <p>A completed reset invalidates other PaperPilot sessions.</p>
              </div>
            </li>
          </ol>
        </section>

        <section className="auth-paper" aria-labelledby="recovery-form-title">
          <div className="auth-paper-running-head">
            <span>Recovery docket</span>
            <BookOpenCheck size={17} aria-hidden="true" />
          </div>
          <div className="auth-form-heading">
            <p className="eyebrow">{eyebrow}</p>
            <h2 id="recovery-form-title">{title}</h2>
            <p>{detail}</p>
          </div>
          {children}
        </section>
      </main>
    </div>
  );
}

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    setPending(true);

    try {
      await authClient.requestPasswordReset({
        email,
        redirectTo: PASSWORD_RESET_CALLBACK_PATH,
      });
    } catch {
      // Network, configuration, unknown-address, and provider outcomes receive
      // the same browser response so the form cannot enumerate accounts.
    } finally {
      setPending(false);
      setComplete(true);
    }
  }

  return (
    <RecoveryFrame
      eyebrow="Request a reset"
      title="Recover your account."
      detail="Enter the email used for PaperPilot. We will send a reset link when the account is eligible."
    >
      {complete ? (
        <div className="auth-recovery-result" role="status">
          <MailCheck size={24} aria-hidden="true" />
          <h3>Check your inbox.</h3>
          <p>
            If an eligible PaperPilot account uses that address, a password-reset link is on
            its way. For privacy, PaperPilot shows this same response for every address.
          </p>
          <Link className="button secondary full" href="/sign-in">Return to sign in</Link>
        </div>
      ) : (
        <form className="auth-form" onSubmit={submit}>
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
          <button className="button primary full auth-submit" type="submit" disabled={pending}>
            {pending ? <LoaderCircle className="auth-spinner" size={16} /> : null}
            {pending ? "Working…" : "Send reset link"}
          </button>
        </form>
      )}
    </RecoveryFrame>
  );
}

type ResetTokenState = { status: "loading" | "invalid" } | { status: "ready"; token: string };

export function ResetPasswordForm() {
  const [tokenState, setTokenState] = useState<ResetTokenState>({ status: "loading" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [complete, setComplete] = useState(false);
  const resetLink = useRef<ResetLinkState | null>(null);

  useEffect(() => {
    if (!resetLink.current) {
      resetLink.current = resetLinkStateFromUrl(window.location.href, window.location.origin);
      window.history.replaceState(window.history.state, "", resetLink.current.cleanPath);
    }
    const result = resetLink.current;
    queueMicrotask(() => {
      setTokenState(result.token
        ? { status: "ready", token: result.token }
        : { status: "invalid" });
    });
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || tokenState.status !== "ready") return;

    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("password") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");
    if (newPassword !== confirmation) {
      setError("The password confirmation does not match.");
      return;
    }

    setPending(true);
    setError(undefined);
    try {
      const result = await authClient.resetPassword({
        newPassword,
        token: tokenState.token,
      });
      if (result.error) {
        setError("This reset link is invalid or expired. Request a fresh link and try again.");
        resetLink.current = { token: null, cleanPath: PASSWORD_RESET_CALLBACK_PATH };
        setTokenState({ status: "invalid" });
        return;
      }
      resetLink.current = { token: null, cleanPath: PASSWORD_RESET_CALLBACK_PATH };
      setTokenState({ status: "invalid" });
      setComplete(true);
    } catch {
      setError("The password could not be updated. Request a fresh link and try again.");
    } finally {
      setPending(false);
    }
  }

  let content: ReactNode;
  if (complete) {
    content = (
      <div className="auth-recovery-result" role="status">
        <ShieldCheck size={24} aria-hidden="true" />
        <h3>Password updated.</h3>
        <p>Your other PaperPilot sessions have been revoked. Sign in with the new password.</p>
        <Link className="button primary full" href="/sign-in">Sign in</Link>
      </div>
    );
  } else if (tokenState.status === "loading") {
    content = (
      <div className="auth-recovery-loading" role="status">
        <LoaderCircle className="auth-spinner" size={18} />
        Checking the reset link…
      </div>
    );
  } else if (tokenState.status === "invalid") {
    content = (
      <div className="auth-recovery-result" role="alert">
        <KeyRound size={24} aria-hidden="true" />
        <h3>Request a fresh link.</h3>
        <p>This reset link is invalid, expired, or has already been used.</p>
        <Link className="button secondary full" href="/forgot-password">Start again</Link>
      </div>
    );
  } else {
    content = (
      <form className="auth-form" onSubmit={submit}>
        <label className="field-group">
          <span className="field-label">New password</span>
          <input
            className="text-input"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
            disabled={pending}
          />
          <span className="field-help">Use 8 to 128 characters.</span>
        </label>
        <label className="field-group">
          <span className="field-label">Confirm new password</span>
          <input
            className="text-input"
            name="confirmation"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
            disabled={pending}
          />
        </label>
        {error ? <div className="auth-error" role="alert">{error}</div> : null}
        <button className="button primary full auth-submit" type="submit" disabled={pending}>
          {pending ? <LoaderCircle className="auth-spinner" size={16} /> : null}
          {pending ? "Updating…" : "Set new password"}
        </button>
      </form>
    );
  }

  return (
    <RecoveryFrame
      eyebrow="Choose a password"
      title="Reset access."
      detail="Set a new password for this one-time recovery link."
    >
      {content}
    </RecoveryFrame>
  );
}
