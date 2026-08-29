"use client";

import { Button } from "@cloudflare/kumo/components/button";

export interface Message {
  from: "user" | "agent";
  text: string;
}

export interface Suggestion {
  id: string;
  label: string;
  done: boolean;
}

interface Props {
  title: string;
  blurb: string;
  messages: Message[];
  suggestionsLabel: string;
  suggestions: Suggestion[];
  onSuggestion: (id: string) => void;
  status: string;
}

export function ChatPanel({
  title,
  blurb,
  messages,
  suggestionsLabel,
  suggestions,
  onSuggestion,
  status,
}: Props) {
  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-r border-kumo-hairline bg-kumo-base">
      <div className="border-b border-kumo-hairline px-5 py-4">
        <h2 className="text-sm font-semibold text-kumo-strong">{title}</h2>
        <p className="mt-1 text-[13px] leading-normal text-kumo-subtle">{blurb}</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        {messages.map((m, i) => (
          <div key={i} className={m.from === "user" ? "flex justify-end" : "flex justify-start"}>
            <p
              className={`max-w-[19rem] rounded-xl px-3 py-2 text-[13px] leading-normal ${
                m.from === "user"
                  ? "bg-kumo-brand text-white"
                  : "border border-kumo-hairline bg-kumo-recessed text-kumo-default"
              }`}
            >
              {m.text}
            </p>
          </div>
        ))}
        <p className="text-[13px] text-kumo-placeholder">{status}</p>
      </div>

      <div className="border-t border-kumo-hairline px-5 py-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder">
          {suggestionsLabel}
        </p>
        <div className="mb-3 flex flex-col gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={s.done}
              onClick={() => onSuggestion(s.id)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-[12.5px] transition
                focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-focus ${
                  s.done
                    ? "cursor-default border-kumo-hairline bg-kumo-recessed text-kumo-inactive"
                    : "border-kumo-hairline bg-kumo-base text-kumo-subtle hover:border-kumo-info hover:bg-kumo-info-tint hover:text-kumo-info"
                }`}
            >
              <span aria-hidden="true" className="shrink-0 text-base leading-none">
                {s.done ? "·" : "+"}
              </span>
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex h-10 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base pl-3 pr-1 shadow-sm">
          <span className="flex-1 text-[13px] text-kumo-placeholder">
            Describe another flow…
          </span>
          <Button size="sm" variant="secondary" aria-label="Send">
            →
          </Button>
        </div>
      </div>
    </aside>
  );
}
