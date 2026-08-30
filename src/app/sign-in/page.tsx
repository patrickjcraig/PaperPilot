import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = {
  title: "Sign in — PaperPilot",
  description: "Sign in to a durable PaperPilot research workspace.",
};

export default function SignInPage() {
  return <AuthForm mode="sign-in" />;
}

