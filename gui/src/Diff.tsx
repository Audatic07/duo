/** Unified diff, file by file, collapsible. */
export function DiffView({ diff, open = 6 }: { diff: string; open?: number }) {
  const files = diff.split(/^(?=diff --git )/m).filter((f) => f.trim());
  if (!files.length) return <div class="muted pad">No changes.</div>;
  return (
    <div class="diffs">
      {files.map((f) => {
        const name = /^diff --git a\/(.+?) b\//.exec(f)?.[1] ?? 'file';
        const lines = f.split('\n');
        const adds = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
        const dels = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
        return (
          <details class="diff-file" open={files.length <= open}>
            <summary><span class="mono">{name}</span> <span class="good-text">+{adds}</span> <span class="bad-text">−{dels}</span></summary>
            <div class="diff">
              {lines.slice(1).map((l) => <div class={l.startsWith('@@') ? 'hunk' : l.startsWith('+++') || l.startsWith('---') || l.startsWith('index ') || l.startsWith('new file') || l.startsWith('deleted file') ? 'meta' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx'}>{l || ' '}</div>)}
            </div>
          </details>
        );
      })}
    </div>
  );
}
