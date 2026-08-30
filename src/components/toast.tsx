"use client";

import { Check } from "lucide-react";

export type ToastMessage = {
  id: number;
  title: string;
  detail: string;
};

export function ToastRegion({ messages }: { messages: ToastMessage[] }) {
  return (
    <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
      {messages.map((message) => (
        <div className="toast" key={message.id}>
          <span className="toast-icon"><Check size={14} aria-hidden="true" /></span>
          <span>
            <strong>{message.title}</strong>
            <span>{message.detail}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
