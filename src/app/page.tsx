import { cookies } from "next/headers";

import { HelmShell } from "@/components/helm-shell";
import { parseSplitLayout, splitLayoutCookieName } from "@/components/split-layout";

export default async function Home() {
  const cookieStore = await cookies();
  return <HelmShell defaultLayout={parseSplitLayout(cookieStore.get(splitLayoutCookieName)?.value)} />;
}
