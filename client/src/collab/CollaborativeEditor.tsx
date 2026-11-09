import { useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { RefreshCw } from 'lucide-react';
import type { YjsSocketProvider } from './YjsSocketProvider';
import { bindMonacoToYjs, type MonacoBinding } from './monacoBinding';
import type { Collaborator } from './types';

interface CollaborativeEditorProps {
  provider: YjsSocketProvider;
  language: string;
  readOnly: boolean;
  collaborators: Collaborator[];
}

/**
 * Monaco is bound to the provider's Y.Text rather than to React state. React
 * never owns the document text, so fast typing and remote updates do not fight
 * over a controlled `value` prop.
 */
export default function CollaborativeEditor({
  provider,
  language,
  readOnly,
  collaborators,
}: CollaborativeEditorProps) {
  const bindingRef = useRef<MonacoBinding | null>(null);

  useEffect(() => () => {
    bindingRef.current?.dispose();
    bindingRef.current = null;
  }, [provider]);

  useEffect(() => {
    bindingRef.current?.refresh();
  }, [collaborators]);

  const handleMount: OnMount = (editor, monaco) => {
    bindingRef.current?.dispose();
    bindingRef.current = bindMonacoToYjs({
      editor,
      monaco,
      doc: provider.doc,
      text: provider.text,
      getCollaborators: () => provider.getState().collaborators,
      ownSocketId: provider.getSocketId(),
      onCursor: (cursor) => provider.setCursor(cursor),
    });
    bindingRef.current.refresh();
  };

  return (
    <Editor
      path={`${provider.fileId}-${provider.instanceId}`}
      height="100%"
      language={language}
      defaultValue={provider.text.toString()}
      onMount={handleMount}
      theme="vs-dark"
      loading={(
        <div className="editor-placeholder">
          <RefreshCw size={20} className="spin" />
          <span>Connecting to the live document…</span>
        </div>
      )}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        lineHeight: 22,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
        fontLigatures: true,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 18, bottom: 20 },
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        renderLineHighlight: 'gutter',
        roundedSelection: true,
        wordWrap: 'on',
        tabSize: 2,
        readOnly,
        readOnlyMessage: {
          value: readOnly
            ? 'Viewers can read this project but cannot edit its files.'
            : 'Reconnecting — editing resumes when the live document is synchronized.',
        },
      }}
    />
  );
}
