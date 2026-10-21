import React from 'react';

interface NewChatButtonProps {
  onNewChat: () => void;
  /** A question is in flight: a new chat would cut it off, so it waits. */
  busy?: boolean;
  /**
   * "Ask this session": the agent session that opened Plannotator answers, and
   * it keeps its own memory, so the button only clears the panel. The label
   * says so instead of promising fresh context.
   */
  sessionBridge?: boolean;
}

export function newChatLabels(sessionBridge: boolean): { label: string; title: string } {
  return sessionBridge
    ? {
        label: 'Clear chat',
        title: 'Clear this panel. The session that opened Plannotator still remembers earlier questions.',
      }
    : {
        label: 'New chat',
        title: 'Clear this chat and start a fresh AI session',
      };
}

/** The Ask AI panel's "New chat" row (#1981). */
export const NewChatButton: React.FC<NewChatButtonProps> = ({ onNewChat, busy = false, sessionBridge = false }) => {
  const { label, title } = newChatLabels(sessionBridge);
  return (
    <div className="flex items-center justify-end px-2 pt-1.5 pb-0.5" data-ai-new-chat-row>
      <button
        type="button"
        onClick={onNewChat}
        disabled={busy}
        title={busy ? 'Wait for the answer, or stop it, before starting a new chat' : title}
        data-ai-new-chat
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        {label}
      </button>
    </div>
  );
};
