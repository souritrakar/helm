/**
 * Which process holds a listening TCP port, answered by the kernel through procfs.
 *
 * A live pidfile proves that a process exists, not that it bound the configured
 * endpoint, so doctor resolves the listener itself before calling a busy port
 * healthy. Linux only, like the rest of the launcher; an unreadable procfs
 * yields "unknown", which the caller reports rather than assumes away.
 */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

const LISTEN_STATE = "0A";
const SOCKET_LINK = /^socket:\[(\d+)]$/;

/** The pid listening on `port`, or `null` when no visible process owns it. */
export function listenerPid(port: number): number | null {
  const inodes = listeningInodes(port);
  if (inodes.size === 0) return null;
  for (const pid of processIds()) {
    if (ownsAnyInode(pid, inodes)) return pid;
  }
  return null;
}

/**
 * Whether `pid` is `leader` or runs in the process group `leader` heads.
 *
 * The launcher records the group leader it spawned, while the process that
 * binds the port is that leader's descendant, and the group is the same unit
 * `bin/helm stop` signals.
 */
export function belongsToProcessGroup(pid: number, leader: number): boolean {
  return pid === leader || processGroupId(pid) === leader;
}

function listeningInodes(port: number): Set<string> {
  const inodes = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of readText(table).split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== LISTEN_STATE) continue;
      const local = fields[1] ?? "";
      if (Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16) === port) {
        inodes.add(fields[9] as string);
      }
    }
  }
  return inodes;
}

function ownsAnyInode(pid: number, inodes: ReadonlySet<string>): boolean {
  let descriptors: string[];
  try {
    descriptors = readdirSync(`/proc/${String(pid)}/fd`);
  } catch {
    return false;
  }
  for (const descriptor of descriptors) {
    let link: string;
    try {
      link = readlinkSync(`/proc/${String(pid)}/fd/${descriptor}`);
    } catch {
      continue;
    }
    const match = SOCKET_LINK.exec(link);
    if (match !== null && inodes.has(match[1] as string)) return true;
  }
  return false;
}

function processIds(): number[] {
  try {
    return readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  } catch {
    return [];
  }
}

function processGroupId(pid: number): number | null {
  // comm can contain spaces and parentheses, so the numeric fields start after the last ") ".
  const stat = readText(`/proc/${String(pid)}/stat`);
  const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
  const pgrp = Number(fields[2]);
  return Number.isInteger(pgrp) ? pgrp : null;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
