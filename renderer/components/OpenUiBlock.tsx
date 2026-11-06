import { useState } from 'react';
import { Renderer, defineAction } from '@openuidev/react-lang';
import { openuiChatLibrary } from '@openuidev/react-ui/genui-lib';
import { z } from 'zod/v4';
import { ipc } from '../lib/ipc';

// Real OpenUI, no homegrown renderer: the model writes OpenUI Lang and this
// draws it with the official @openuidev/react-lang Renderer against the
// official chat component library.

// The chat library ships only the two builtin actions (@ToAssistant,
// @OpenUrl). Copy-to-clipboard is a host capability, so it is added here and
// the model gets it in the prompt automatically (library.prompt()).
const copyAction = defineAction({
  name: 'Copy',
  description: 'Copy a short value (text, code, a row) to the clipboard.',
  params: z.object({ text: z.string() }),
});

const library = openuiChatLibrary.extend({ actions: { add: [copyAction] } });

type Props = {
  code: string;
  streaming?: boolean;
  onSubmit?: (prompt: string) => void;
  onCopy?: (text: string) => void;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function OpenUiBlock({ code, streaming = false, onSubmit, onCopy }: Props) {
  const [error, setError] = useState<string | null>(null);

  if (error && !streaming) {
    return (
      <div className="spirit-openui spirit-openui-panel mt-1.5 mb-2 rounded-2xl px-3.5 py-3 text-[12px] text-white/60 dark:text-neutral-500">
        This generated view could not be drawn.
      </div>
    );
  }

  return (
    <div className="spirit-openui spirit-openui-panel mt-1.5 mb-2 rounded-2xl px-3.5 py-3 text-[13px] text-white/90 dark:text-neutral-800">
      <Renderer
        response={code}
        library={library}
        isStreaming={streaming}
        onError={(errs) => setError(errs.length ? errs[0].message : null)}
        onAction={(event) => {
          if (event.type === 'Copy') {
            const text = str((event.params as Record<string, unknown>).text);
            if (text) onCopy?.(text);
            return;
          }
          if (event.type === 'continue_conversation') {
            const message =
              str((event.params as Record<string, unknown>).message) || event.humanFriendlyMessage;
            if (message) onSubmit?.(message);
            return;
          }
          if (event.type === 'open_url') {
            const url = str((event.params as Record<string, unknown>).url);
            if (url) void ipc.openExternal(url);
          }
        }}
      />
    </div>
  );
}
