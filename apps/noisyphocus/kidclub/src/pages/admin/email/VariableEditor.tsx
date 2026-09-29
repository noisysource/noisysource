import { useEffect } from 'react';
import { useEditor, EditorContent, Editor, Node, mergeAttributes } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { VARIABLES, VARIABLE_LABEL, VariableKey } from './variables';

/**
 * A variable in the body: one indivisible tag (can't be half-deleted or
 * mistyped). Stored as `<span data-variable="key">Label</span>`; the label is
 * only for display — renderBody() replaces the whole span with the value.
 */
const Variable = Node.create({
  name: 'variable',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      key: {
        default: null,
        parseHTML: el => el.getAttribute('data-variable'),
        renderHTML: attrs => ({ 'data-variable': attrs.key }),
      },
    };
  },
  parseHTML() { return [{ tag: 'span[data-variable]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'email-var' }),
      VARIABLE_LABEL[node.attrs.key as VariableKey] ?? node.attrs.key];
  },
  renderText({ node }) { return `{{${node.attrs.key}}}`; },
});

export const DRAG_MIME = 'application/x-email-variable';

/** What a palette chip carries when dragged: the editor reads HTML, the subject input reads text. */
export function setVariableDragData(e: React.DragEvent, key: VariableKey) {
  e.dataTransfer.setData(DRAG_MIME, key);
  e.dataTransfer.setData('text/html', `<span data-variable="${key}">${VARIABLE_LABEL[key]}</span>`);
  e.dataTransfer.setData('text/plain', `{{${key}}}`);
  e.dataTransfer.effectAllowed = 'copy';
}

export function insertVariable(editor: Editor | null, key: VariableKey) {
  editor?.chain().focus().insertContent({ type: 'variable', attrs: { key } }).insertContent(' ').run();
}

export function useVariableEditor(initialHtml: string, onChange: (html: string) => void) {
  return useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false } }),
      Variable,
    ],
    content: initialHtml,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: { class: 'email-editor min-h-[240px] px-3 py-2 focus:outline-none' },
    },
  });
}

/** Replace the editor's content (loading a template), without echoing back as a user edit. */
export function useSyncContent(editor: Editor | null, html: string, version: number) {
  useEffect(() => {
    if (editor && editor.getHTML() !== html) editor.commands.setContent(html, { emitUpdate: false });
    // Only when a new document is loaded (version bump), not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, version]);
}

function ToolButton({ on, active, children, title }: { on: () => void; active?: boolean; children: React.ReactNode; title: string }) {
  return (
    <button type="button" title={title} onMouseDown={e => { e.preventDefault(); on(); }}
      className={`px-2 py-1 rounded text-sm ${active ? 'bg-gray-200 text-gray-900' : 'text-gray-600 hover:bg-gray-100'}`}>
      {children}
    </button>
  );
}

export function EditorToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Endereço do link (vazio para remover)', prev ?? 'https://');
    if (url === null) return;
    if (!url.trim()) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };
  return (
    <div className="flex flex-wrap gap-1 border-b border-gray-200 px-2 py-1 bg-gray-50 rounded-t-lg">
      <ToolButton title="Negrito" on={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')}><b>B</b></ToolButton>
      <ToolButton title="Itálico" on={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')}><i>I</i></ToolButton>
      <ToolButton title="Sublinhado" on={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')}><u>U</u></ToolButton>
      <ToolButton title="Título" on={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading')}>T</ToolButton>
      <ToolButton title="Lista" on={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')}>• Lista</ToolButton>
      <ToolButton title="Link" on={setLink} active={editor.isActive('link')}>🔗 Link</ToolButton>
    </div>
  );
}

export function BodyEditor({ editor }: { editor: Editor | null }) {
  return (
    <div className="border border-gray-300 rounded-lg bg-white">
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

/** Variables grouped; click inserts at the cursor of the last focused field, or drag into place. */
export function VariablePalette({ onInsert }: { onInsert: (key: VariableKey) => void }) {
  const groups = Array.from(new Set(VARIABLES.map(v => v.group)));
  return (
    <div className="space-y-3">
      {groups.map(g => (
        <div key={g}>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{g}</p>
          <div className="flex flex-wrap gap-1.5">
            {VARIABLES.filter(v => v.group === g).map(v => (
              <button key={v.key} type="button" draggable
                onDragStart={e => setVariableDragData(e, v.key)}
                onMouseDown={e => e.preventDefault()}
                onClick={() => onInsert(v.key)}
                title={`Ex.: ${v.example} — clique ou arraste`}
                className="email-var cursor-grab active:cursor-grabbing">
                {v.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
