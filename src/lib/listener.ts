/**
 * Which process holds a listening TCP port, answered by the kernel through procfs.
 *
 * A live pidfile proves that a process exists, not that it bound the configured
 * endpoint, so doctor resolves the listener itself before calling a busy port
 * healthy. Linux only, like the rest of the launcher; an unreadable procfs
 * yields "unknown", which the caller reports rather than assumes away.
 */
import { lookup } from "node:dns/promises";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

import type { HelmEndpoint } from "./config";

const LISTEN_STATE = "0A";
const SOCKET_LINK = /^socket:\[(\d+)]$/;

/**
 * Every visible pid listening on `endpoint`, in procfs order.
 *
 * One port can carry several listeners on different local addresses. Match the
 * configured local address too, so a helm socket on another address cannot
 * vouch for a foreign process that owns the configured endpoint.
 */
export async function listenerPids(endpoint: HelmEndpoint): Promise<number[]> {
  const inodes = await listeningInodes(endpoint);
  if (inodes.size === 0) return [];
  return processIds().filter((pid) => ownsAnyInode(pid, inodes));
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

async function listeningInodes(endpoint: HelmEndpoint): Promise<Set<string>> {
  const inodes = new Set<string>();
  for (const { table, address } of await procAddresses(endpoint.bind)) {
    for (const line of readText(table).split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== LISTEN_STATE) continue;
      const local = fields[1] ?? "";
      const [localAddress, localPort] = local.split(":");
      if (localAddress === address && Number.parseInt(localPort ?? "", 16) === endpoint.port) {
        inodes.add(fields[9] as string);
      }
    }
  }
  return inodes;
}

interface ProcAddress {
  readonly table: "/proc/net/tcp" | "/proc/net/tcp6";
  readonly address: string;
}

async function procAddresses(bind: string): Promise<ProcAddress[]> {
  const ipv4 = ipv4ProcAddress(bind);
  if (ipv4 !== null) return [{ table: "/proc/net/tcp", address: ipv4 }];
  const ipv6 = ipv6ProcAddress(bind);
  if (ipv6 !== null) return [{ table: "/proc/net/tcp6", address: ipv6 }];
  try {
    const resolved = await lookup(bind, { verbatim: true });
    const address = resolved.family === 4 ? ipv4ProcAddress(resolved.address) : ipv6ProcAddress(resolved.address);
    return address === null
      ? []
      : [{ table: resolved.family === 4 ? "/proc/net/tcp" : "/proc/net/tcp6", address }];
  } catch {
    return [];
  }
}

function ipv4ProcAddress(bind: string): string | null {
  const octets = bind.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet))) return null;
  const values = octets.map(Number);
  if (values.some((octet) => octet < 0 || octet > 255)) return null;
  return values.reverse().map((octet) => octet.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function ipv6ProcAddress(bind: string): string | null {
  const groups = expandIpv6(bind);
  if (groups === null) return null;
  const networkOrder = groups.map((group) => group.toString(16).padStart(4, "0")).join("");
  return networkOrder.match(/.{8}/g)!.map(reverseBytes).join("").toUpperCase();
}

function expandIpv6(address: string): number[] | null {
  if (address.includes(".")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const groups = [...left, ...right];
  if (groups.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  if (halves.length === 1 && groups.length !== 8) return null;
  if (groups.length > 8) return null;
  return [...left, ...Array(8 - groups.length).fill("0"), ...right].map((group) => Number.parseInt(group, 16));
}

function reverseBytes(hex: string): string {
  return hex.match(/.{2}/g)!.reverse().join("");
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
