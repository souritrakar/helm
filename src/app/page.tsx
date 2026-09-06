/**
 * Placeholder shell. The terminal pane (Lane B), the inbox pane (Lane C/D), and
 * the split layout (Lane F) replace this.
 */
export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">helm</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Browser control and human inbox for firstmate. Foundation only — panes land in later lanes.
        </p>
      </div>
    </main>
  );
}
