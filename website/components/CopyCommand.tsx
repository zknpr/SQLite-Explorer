'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** A shell command with a copy button. The command is the label; nothing else decorates it. */
export default function CopyCommand({ command, className = '' }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Copying the command failed:', error);
      setFailed(true);
    }
  };

  return (
    <div className={`flex min-w-0 items-center gap-2 rounded-lg border border-edge bg-subtle py-1.5 pl-4 pr-1.5 ${className}`}>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1.5 text-[0.9rem]">{command}</code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md p-2 text-subtle-foreground hover:bg-edge/60 hover:text-foreground"
        aria-label={copied ? 'Copied' : failed ? 'Copy failed, select the text instead' : 'Copy command'}
      >
        {copied ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <Copy className="h-4 w-4" strokeWidth={1.75} />}
      </button>
    </div>
  );
}
