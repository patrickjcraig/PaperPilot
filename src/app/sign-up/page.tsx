import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = {
  title: "Create workspace — PaperPilot",
  description: "Create a durable PaperPilot research workspace.",
};

export default function SignUpPage() {
  return <AuthForm mode="sign-up" />;
}

