import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/account-recovery-form";

export const metadata: Metadata = {
  title: "Recover account — PaperPilot",
  description: "Request a PaperPilot password-reset link.",
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}

