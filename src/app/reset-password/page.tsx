import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/account-recovery-form";

export const metadata: Metadata = {
  title: "Reset password — PaperPilot",
  description: "Choose a new PaperPilot password.",
  referrer: "no-referrer",
};

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}

