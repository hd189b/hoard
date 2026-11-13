// Talking to Git hosts. Two engines share one interface:
//  - IsoTransport: isomorphic-git over HTTPS, runs everywhere (incl. Android)
//  - CliTransport (src/platform/git-cli.ts): the installed `git` program, desktop only, for SSH

import git from "isomorphic-git";
import type { HttpClient } from "isomorphic-git";
import { BRANCH, LARGE_PREFIX, STEP_PREFIX } from "./format";
import { Repo } from "./repo";

export interface Credentials {
  username?: string;
  /** Password or access token. */
  password?: string;
  /** SSH private key path (system engine only). */
  sshKeyPath?: string;
  /** SSH key passphrase (system engine only). */
  sshPassphrase?: string;
}

export interface Endpoint {
  /** Stable id used for the remote-tracking ref, e.g. "r1-0". */
  id: string;
  /** Display name, e.g. "GitHub". */
  name: string;
  url: string;
  getCredentials: () => Promise<Credentials | undefined>;
}

export class PushRejectedError extends Error {
  constructor(msg = "The host has newer changes") {
    super(msg);
    this.name = "PushRejectedError";
  }
}

export class ProtectedBranchError extends Error {
  constructor(hostMessage: string) {
    super(
      `The host refused to overwrite its protected branch (${hostMessage.trim().slice(0, 160)}). ` +
        `Allow force-push on "main" in the repository's settings, replace, then protect it again.`,
    );
    this.name = "ProtectedBranchError";
  }
}

export class AuthError extends Error {
  constructor(msg = "Sign-in was rejected by the host") {
    super(msg);
    this.name = "AuthError";
  }
}

export interface RefInfo {
  ref: string;
  oid: string;
}

export interface Transport {
  /** The remote's main branch and its encgidian refs (large objects, steps). */
  listRefs(ep: Endpoint): Promise<RefInfo[]>;
  /**
   * Fetch the remote branch into refs/remotes/<id>/main. Returns its commit, or null if the remote is empty.
   * Pass `listing` from listRefs to skip listing again.
   */
  fetch(ep: Endpoint, listing?: RefInfo[], have?: string | null): Promise<string | null>;
  /**
   * Fetch one non-branch ref into the same local ref name. `have` is a commit this
   * device already has, so the host only sends what is new since then.
   */
  fetchRef(ep: Endpoint, ref: string, have?: string | null): Promise<void>;
  /** Push one non-branch ref. `force` lets a scratch ref move anywhere. */
  pushRef(ep: Endpoint, ref: string, oid: string, opts?: { force?: boolean }): Promise<void>;
  /**
   * Push local main to the remote. Throws PushRejectedError when the remote moved on.
   * `force` replaces whatever the remote branch holds (only used after the user confirms).
   */
  push(ep: Endpoint, oid: string, opts?: { force?: boolean }): Promise<void>;
}

export function isSshUrl(url: string): boolean {
  return /^ssh:\/\//i.test(url) || /^[\w.-]+@[\w.-]+:/.test(url);
}

const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

/** Credentials may only travel over https, ssh, or plain http to this machine. */
export function checkUrlSafety(url: string, hasCredentials: boolean): void {
  if (isSshUrl(url)) return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a valid Git URL: ${url}`);
  }
  if (u.username || u.password) throw new Error("Put credentials in the sign-in settings, not in the URL");
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && (LOCAL_HOSTS.test(u.hostname) || !hasCredentials)) return;
  throw new Error(`Refusing to send credentials over ${u.protocol} (use https://)`);
}

/** Remove anything that looks like a secret from an error message. */
export function scrub(msg: string, creds?: Credentials): string {
  let s = msg.replace(/(\/\/)[^/@\s]+@/g, "$1***@");
  for (const v of [creds?.password, creds?.sshPassphrase]) if (v && v.length >= 4) s = s.split(v).join("***");
  return s;
}

/** Turn low-level connection errors into a sentence a person can act on. */
export function friendlyNetworkError(msg: string): string {
  if (/ECONNREFUSED|Connection refused|Failed to connect/i.test(msg)) return `Can't reach the host: the connection was refused (${msg.split("\n")[0]})`;
  if (/ENOTFOUND|EAI_AGAIN|Could not resolve host|UnknownHostException|Unable to resolve host/i.test(msg)) return "Can't reach the host: its name couldn't be looked up (offline, or a typo in the URL?)";
  if (/ETIMEDOUT|Timed out|timeout/i.test(msg)) return "Can't reach the host: the connection timed out";
  if (/socket hang up|ECONNRESET|connection reset|closed the connection|unexpected disconnect|SocketException|ConnectException|SSLException/i.test(msg)) return "Can't reach the host: the connection was dropped";
  if (/certificate|SSL|TLS/i.test(msg)) return `Secure connection failed (${msg.split("\n")[0]})`;
  return msg;
}

/** A sign-in failure explained: wrong credentials (401) vs. not allowed on this repo (403). */
export function authProblem(status: number | undefined, hostMessage: string, creds?: Credentials): AuthError {
  const why = scrub(hostMessage.replace(/\s+/g, " ").trim(), creds).slice(0, 200);
  if (status === 403) {
    return new AuthError(
      `Signed in, but this token isn't allowed to use this repository; it needs read and write access to it` + (why ? ` (host says: ${why})` : ""),
    );
  }
  return new AuthError(`Sign-in was rejected: the token or password is wrong or has expired` + (why ? ` (host says: ${why})` : ""));
}

function asError(e: unknown, creds?: Credentials): Error {
  const err = e as { code?: string; message?: string; data?: { statusCode?: number; response?: string } };
  const status = err?.data?.statusCode;
  const msg = scrub(String(err?.message ?? e), creds);
  if (err?.code === "HttpError" && (status === 401 || status === 403)) return authProblem(status, String(err.data?.response ?? ""), creds);
  if (err?.code === "PushRejectedError") return new PushRejectedError();
  const out = new Error(friendlyNetworkError(msg));
  out.name = err?.code ?? "Error";
  return out;
}

export class IsoTransport implements Transport {
  constructor(
    private readonly repo: Repo,
    private readonly http: HttpClient,
  ) {}

  private authHooks(creds: Credentials | undefined) {
    let tries = 0;
    return {
      onAuth: () => {
        if (!creds?.password && !creds?.username) return { cancel: true };
        return { username: creds.username || "x-access-token", password: creds.password ?? "" };
      },
      onAuthFailure: () => {
        tries++;
        // Returning nothing stops retries; isomorphic-git then throws the HttpError
        // with the status code and the host's explanation, which asError turns into a message.
        return undefined;
      },
      get failed() {
        return tries > 0;
      },
    };
  }

  /** isomorphic-git wants a configured remote for its ref bookkeeping. No credentials are stored. */
  private async ensureRemote(ep: Endpoint) {
    const g = { fs: this.repo.fs, gitdir: this.repo.gitdir };
    const fetchSpec = `+refs/heads/${BRANCH}:${Repo.remoteRef(ep.id)}`;
    if ((await git.getConfig({ ...g, path: `remote.${ep.id}.url` })) !== ep.url) {
      await git.setConfig({ ...g, path: `remote.${ep.id}.url`, value: ep.url });
    }
    // Main maps to a remote-tracking ref; encgidian refs keep their own names locally.
    const specs = [fetchSpec, "+refs/encgidian/*:refs/encgidian/*"];
    const have = (await git.getConfigAll({ ...g, path: `remote.${ep.id}.fetch` })) as string[];
    if (!have.includes(specs[0])) await git.setConfig({ ...g, path: `remote.${ep.id}.fetch`, value: specs[0] });
    if (!have.includes(specs[1])) await git.setConfig({ ...g, path: `remote.${ep.id}.fetch`, value: specs[1], append: true });
  }

  private async withAuth<T>(ep: Endpoint, fn: (hooks: ReturnType<IsoTransport["authHooks"]>, creds?: Credentials) => Promise<T>): Promise<T> {
    const creds = await ep.getCredentials();
    checkUrlSafety(ep.url, !!creds?.password);
    const hooks = this.authHooks(creds);
    await this.ensureRemote(ep);
    try {
      return await fn(hooks, creds);
    } catch (e) {
      const out = asError(e, creds);
      if (hooks.failed && !(out instanceof AuthError)) throw new AuthError();
      throw out;
    }
  }

  async listRefs(ep: Endpoint): Promise<RefInfo[]> {
    return this.withAuth(ep, async (hooks) => {
      const refs = await git.listServerRefs({ http: this.http, url: ep.url, onAuth: hooks.onAuth, onAuthFailure: hooks.onAuthFailure, prefix: "refs/" });
      return refs
        .filter((r) => r.ref === `refs/heads/${BRANCH}` || r.ref.startsWith("refs/encgidian/"))
        .map((r) => ({ ref: r.ref, oid: r.oid }));
    });
  }

  async fetchRef(ep: Endpoint, ref: string, have?: string | null): Promise<void> {
    await this.withAuth(ep, async (hooks) => {
      // isomorphic-git only tells the host about the local ref of the same name,
      // so point it at a commit we have; otherwise the host sends a full snapshot.
      if (have && !(await this.repo.resolve(ref))) {
        await git.writeRef({ fs: this.repo.fs, gitdir: this.repo.gitdir, ref, value: have, force: true });
      }
      await git.fetch({
        fs: this.repo.fs,
        gitdir: this.repo.gitdir,
        http: this.http,
        url: ep.url,
        remote: ep.id,
        ref,
        remoteRef: ref,
        singleBranch: true,
        tags: false,
        onAuth: hooks.onAuth,
        onAuthFailure: hooks.onAuthFailure,
      });
    });
  }

  async pushRef(ep: Endpoint, ref: string, oid: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.withAuth(ep, async (hooks, creds) => {
      if ((await this.repo.resolve(ref)) !== oid) await git.writeRef({ fs: this.repo.fs, gitdir: this.repo.gitdir, ref, value: oid, force: true });
      const res = await git.push({
        fs: this.repo.fs,
        gitdir: this.repo.gitdir,
        http: this.http,
        url: ep.url,
        remote: ep.id,
        ref,
        remoteRef: ref,
        force: !!opts.force,
        onAuth: hooks.onAuth,
        onAuthFailure: hooks.onAuthFailure,
      });
      if (!res.ok) throw new Error(scrub(res.error ?? `push of ${ref} failed`, creds));
    });
  }

  async fetch(ep: Endpoint, listing?: RefInfo[], have?: string | null): Promise<string | null> {
    const creds = await ep.getCredentials();
    checkUrlSafety(ep.url, !!creds?.password);
    const hooks = this.authHooks(creds);
    await this.ensureRemote(ep);
    try {
      const refs =
        listing ??
        (await git.listServerRefs({
          http: this.http,
          url: ep.url,
          onAuth: hooks.onAuth,
          onAuthFailure: hooks.onAuthFailure,
          prefix: `refs/heads/${BRANCH}`,
        }));
      const remote = refs.find((r) => r.ref === `refs/heads/${BRANCH}`);
      if (!remote) {
        await this.repo.setRemoteHead(ep.id, null);
        return null;
      }
      const known = await this.repo.remoteHead(ep.id);
      if (known !== remote.oid || !(await this.hasCommit(remote.oid))) {
        // Tell the host about the newest commit we have (e.g. a step just fetched),
        // not only our own main, so it doesn't resend what we already downloaded.
        const haveRef = `refs/encgidian/have/${ep.id}`;
        const best = have ?? (await this.repo.head());
        if (best) await git.writeRef({ fs: this.repo.fs, gitdir: this.repo.gitdir, ref: haveRef, value: best, force: true });
        await git.fetch({
          fs: this.repo.fs,
          gitdir: this.repo.gitdir,
          http: this.http,
          url: ep.url,
          remote: ep.id,
          ref: best ? haveRef : BRANCH,
          remoteRef: BRANCH,
          singleBranch: true,
          tags: false,
          onAuth: hooks.onAuth,
          onAuthFailure: hooks.onAuthFailure,
        });
      }
      await this.repo.setRemoteHead(ep.id, remote.oid);
      return remote.oid;
    } catch (e) {
      const out = asError(e, creds);
      if (hooks.failed && !(out instanceof AuthError)) throw new AuthError();
      throw out;
    }
  }

  private async hasCommit(oid: string): Promise<boolean> {
    try {
      await this.repo.readCommit(oid);
      return true;
    } catch {
      return false;
    }
  }

  async push(ep: Endpoint, oid: string, opts: { force?: boolean } = {}): Promise<void> {
    const creds = await ep.getCredentials();
    checkUrlSafety(ep.url, !!creds?.password);
    const hooks = this.authHooks(creds);
    await this.ensureRemote(ep);
    const head = await this.repo.head();
    if (head !== oid) throw new Error("internal: push of a commit that is not the local head");
    let res;
    try {
      res = await git.push({
        fs: this.repo.fs,
        gitdir: this.repo.gitdir,
        http: this.http,
        url: ep.url,
        remote: ep.id,
        ref: BRANCH,
        remoteRef: BRANCH,
        force: !!opts.force,
        onAuth: hooks.onAuth,
        onAuthFailure: hooks.onAuthFailure,
      });
    } catch (e) {
      const out = asError(e, creds);
      if (hooks.failed && !(out instanceof AuthError)) throw new AuthError();
      throw out;
    }
    const refErr = res.refs?.[`refs/heads/${BRANCH}`];
    if (!res.ok || (refErr && !refErr.ok)) {
      const why = refErr?.error ?? res.error ?? "push failed";
      if (/protected branch|pre-receive hook declined|not allowed to force push/i.test(why)) throw new ProtectedBranchError(why);
      if (/non-fast-forward|fetch first|rejected|stale/i.test(why)) throw new PushRejectedError();
      throw new Error(scrub(why, creds));
    }
    await this.repo.setRemoteHead(ep.id, oid);
  }
}
