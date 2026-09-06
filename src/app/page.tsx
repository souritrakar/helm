import { TerminalPane } from "@/components/terminal-pane";

/** Lane B deliberately owns only the terminal component; Lane F composes the shell. */
export default function Home() {
  return <main className="flex flex-1 min-h-0"><TerminalPane /></main>;
}
