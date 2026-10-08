import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, lstat, open, mkdir, mkdtemp, readdir, readFile, writeFile, rename, rm, type FileHandle } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { resolve, relative, isAbsolute, sep, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
const exec = promisify(execFile);

/** Host-owned packs retain snapshot trees independently of the agent-writable repository refs. */
export class GitCheckpoints {
  private readonly redact: (text:string)=>string;
  private readonly retain: number;
  private readonly trusted = new Map<string,{cwd:string;sessionId:string;oid:string;indexOid?:string;pack?:string}>();
  private loaded = false;
  private writes:Promise<void> = Promise.resolve();
  private captures:Promise<void> = Promise.resolve();
  private readonly heldPacks=new Map<string,number>();
  private readonly storagePath?:string;
  constructor(redact: (text: string) => string, retain = 50, storagePath?:string) {this.redact=redact;this.retain=retain;this.storagePath=storagePath;}
  private async load():Promise<void> {
    if(this.loaded)return;
    if(this.storagePath) {
      try {
        const text=await readFile(this.storagePath,"utf8");
        if(Buffer.byteLength(text)>4*1024*1024)throw new Error("Checkpoint registry is too large.");
        const values=JSON.parse(text) as unknown;
        if(!Array.isArray(values))throw new Error("Invalid checkpoint registry.");
        for(const row of values) {
          if(!row || typeof row.id!=="string" || typeof row.cwd!=="string" || typeof row.sessionId!=="string" || !/^[a-f0-9]{40,64}$/.test(row.oid))throw new Error("Invalid checkpoint registry.");
          if(row.indexOid!==undefined && !/^[a-f0-9]{40,64}$/u.test(row.indexOid))throw new Error("Invalid checkpoint index object.");
          if(row.pack!==undefined && !/^[a-f0-9]{40,64}$/u.test(row.pack))throw new Error("Invalid checkpoint pack.");
          this.trusted.set(row.id,{cwd:row.cwd,sessionId:row.sessionId,oid:row.oid,...(row.indexOid ? {indexOid:row.indexOid} : {}),...(row.pack ? {pack:row.pack} : {})});
        }
      }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    }
    await this.pruneAbandonedPackStaging();
    this.loaded=true;
  }
  private async pruneAbandonedPackStaging():Promise<void> {
    if(!this.storagePath)return;
    const root=join(dirname(this.storagePath),"checkpoint-objects");
    const projects=await readdir(root,{withFileTypes:true}).catch(error=>{
      if((error as NodeJS.ErrnoException).code==="ENOENT")return [];
      throw error;
    });
    for(const project of projects) {
      if(!project.isDirectory() || !/^[a-f0-9]{64}$/u.test(project.name))continue;
      const directory=join(root,project.name);
      for(const entry of await readdir(directory,{withFileTypes:true})) {
        const owner=/^\.pending-([1-9][0-9]{0,9})-[A-Za-z0-9]{6}$/u.exec(entry.name);
        if(!entry.isDirectory() || !owner)continue;
        const pid=Number(owner[1]);if(pid>0x7fffffff)continue;
        try {process.kill(pid,0);}catch(error) {
          // A reused/live PID or an inaccessible process keeps its staging folder. Only confirmed
          // dead owners are removed; no shared packs or another running capture can be swept.
          if((error as NodeJS.ErrnoException).code==="ESRCH")await this.removePackStaging(join(directory,entry.name));
        }
      }
    }
  }
  private async removePackStaging(path:string):Promise<void> {
    await rm(path,{recursive:true,force:true}).catch(error=>{
      // Cleanup failure must not turn an already published valid pack into an unregistered capture.
      console.warn("Could not remove unfinished checkpoint files.",(error as NodeJS.ErrnoException).code ?? "unknown error");
    });
  }
  private async persist():Promise<void> {
    if(!this.storagePath)return;
    const file=this.storagePath, text=JSON.stringify([...this.trusted].map(([id,row])=>({id,...row})));
    const work=this.writes.catch(()=>undefined).then(async()=>{
      await mkdir(dirname(file),{recursive:true,mode:0o700});
      const temp=`${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp,text,{mode:0o600,flag:"wx"});await rename(temp,file);
      } catch(error) {
        await rm(temp,{force:true}).catch(()=>undefined);
        throw error;
      }
    });
    this.writes=work;await work;
  }
  private prefix(sessionId: string): string {
    if (!/^[\w-]{1,100}$/.test(sessionId)) throw new Error("Invalid checkpoint session.");
    return `refs/canvastty/${sessionId}/`;
  }
  private async git(cwd: string, args: string[]): Promise<string> {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
    const safe = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external="];
    // Snapshotting runs outside the agent process; never execute repository-provided clean filters.
    const configured = await exec("git", [...safe, "-C", cwd, "config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], {env, timeout: 5000}).catch((error: unknown) => {
      if ((error as {code?: unknown}).code === 1) return {stdout: ""}; throw error;
    });
    for (const line of configured.stdout.split("\n")) {
      const key = line.split(/\s/, 1)[0];
      if (/^filter\..*\.(clean|smudge|process|required)$/.test(key)) safe.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
    }
    return (await exec("git", [...safe, "-C", cwd, ...args], {env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024})).stdout.trimEnd();
  }
  async available(cwd: string): Promise<boolean> {
    try { return await realpath(await this.git(cwd, ["rev-parse", "--show-toplevel"])) === await realpath(cwd); }
    catch { return false; }
  }
  async workingDiff(cwd:string, baselineHead?:string):Promise<string> {
    if (baselineHead !== undefined && !/^[a-f0-9]{40,64}$/u.test(baselineHead)) throw new Error("Invalid review baseline commit.");
    const parts = [await this.git(cwd,["diff","--no-ext-diff","--no-textconv","--unified=3",baselineHead ?? "HEAD","--"])];
    const root = await realpath(cwd);
    const paths = (await this.git(cwd,["ls-files","--others","--exclude-standard","-z"])).split("\0").filter(Boolean);
    let bytes = Buffer.byteLength(parts[0]), omitted = 0;
    for (const path of paths) {
      if (bytes >= 512 * 1024 || /[\u0000-\u001F\u007F]/u.test(path)) { omitted++; continue; }
      let file;
      try {
        const full = resolve(root,path), target = await realpath(full), within = relative(root,target);
        const metadata = await lstat(full);
        if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`) || !metadata.isFile() || metadata.size > 32 * 1024) { omitted++; continue; }
        file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = await file.stat();
        if (!opened.isFile() || opened.ino !== metadata.ino || opened.dev !== metadata.dev || opened.size > 32 * 1024) { omitted++; continue; }
        const raw = await readBoundedUntrackedFile(file);
        const after = await file.stat();
        if (raw.includes(0) || raw.length > 32 * 1024 || after.size !== opened.size
          || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) { omitted++; continue; }
        const text = new TextDecoder("utf8", {fatal:true}).decode(raw), lines = text.endsWith("\n") ? text.slice(0,-1).split("\n") : text.split("\n");
        if (!text) lines.length = 0;
        const quoted = JSON.stringify(path);
        const hunk = `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\nnew file mode ${opened.mode & 0o111 ? "100755" : "100644"}\n--- /dev/null\n+++ ${quoted}\n@@ -0,0 +${lines.length ? 1 : 0},${lines.length} @@\n${lines.map(line=>`+${line}`).join("\n")}\n${text && !text.endsWith("\n") ? "\\ No newline at end of file\n" : ""}`;
        parts.push(hunk); bytes += Buffer.byteLength(hunk);
      } catch { omitted++; }
      finally { await file?.close(); }
    }
    if (omitted) parts.push(`[${omitted} untracked file(s) omitted: binary, oversized, unsafe, or unavailable.]`);
    // Mask the complete collected text before taking the bounded tail consumed by the reviewer.
    return this.redact(parts.join("\n")).slice(-512 * 1024);
  }
  async capture(sessionId: string, cwd: string): Promise<void> {
    const work=this.captures.catch(()=>undefined).then(()=>this.captureOne(sessionId,cwd));
    this.captures=work;await work;
  }
  private async captureOne(sessionId:string,cwd:string):Promise<void> {
    await this.load();
    if (!await this.available(cwd)) return;
    const stash = await this.git(cwd, ["stash", "create"]);
    const hash = stash || await this.git(cwd, ["rev-parse", "HEAD"]);
    // A stash's second parent stores its index state. A clean checkpoint can itself be a merge commit,
    // whose second parent is an unrelated branch and must not be used as the saved index.
    const indexOid = stash ? await this.git(cwd, ["rev-parse", "--verify", `${hash}^2`]) : hash;
    const ref = `${this.prefix(sessionId)}${Date.now()}-${randomUUID()}`;
    const root=await realpath(cwd),pack=await this.protectObjects(root,hash,indexOid);
    try {
      await this.git(cwd, ["update-ref", ref, hash]);
    } catch(error) {
      await this.removePackIfUnreferenced(root,pack);
      throw error;
    }

    const previous=new Map([...this.trusted].map(([id,row])=>[id,{...row}]));
    this.trusted.set(ref,{cwd:root,sessionId,oid:hash,indexOid,...(pack ? {pack} : {})});
    let pruned:Array<{id:string;row:{cwd:string;sessionId:string;oid:string;indexOid?:string;pack?:string}}> = [];
    try {
      const snapshots = await this.list(sessionId, cwd);
      pruned=snapshots.slice(this.retain).map(({id})=>({id,row:this.trusted.get(id)!}));
      for (const old of pruned) this.trusted.delete(old.id);
      // Commit the registry before discarding older protected packs. If its atomic replacement fails,
      // retain the previous registry and packs so a failed capture cannot destroy the last good checkpoint.
      await this.persist();
    } catch(error) {
      this.trusted.clear();for(const [id,row] of previous)this.trusted.set(id,row);
      await this.git(cwd,["update-ref","-d",ref]).catch(()=>undefined);
      await this.removePackIfUnreferenced(root,pack);
      throw error;
    }
    for(const old of pruned) {
      await this.git(cwd,["update-ref","-d",old.id]).catch(()=>undefined);
      await this.removePackIfUnreferenced(root,old.row.pack);
    }
  }
  private async removePackIfUnreferenced(cwd:string,pack?:string):Promise<void> {
    if(!pack || this.heldPacks.has(`${cwd}\0${pack}`) || [...this.trusted.values()].some(row=>row.cwd===cwd && row.pack===pack))return;
    const path=this.packPath(cwd,pack);
    if(path)await Promise.all([rm(path,{force:true}),rm(path.slice(0,-5)+".idx",{force:true}),rm(path.slice(0,-5)+".rev",{force:true})]);
  }
  private holdPack(cwd:string,pack?:string):()=>Promise<void> {
    if(!pack)return async()=>undefined;
    const key=`${cwd}\0${pack}`;this.heldPacks.set(key,(this.heldPacks.get(key)??0)+1);
    let released=false;
    return async()=>{
      if(released)return;released=true;
      const count=this.heldPacks.get(key)??0;
      if(count>1)this.heldPacks.set(key,count-1);
      else {this.heldPacks.delete(key);await this.removePackIfUnreferenced(cwd,pack);}
    };
  }
  async list(sessionId: string, cwd: string): Promise<Array<{id: string; at: number; label: string}>> {
    await this.load();
    if (!await this.available(cwd)) return [];
    const root=await realpath(cwd);
    const prefix=this.prefix(sessionId);
    // Only the protected host registry decides which snapshots exist; refs are an additional repository convenience.
    return [...this.trusted].filter(([id,row])=>id.startsWith(prefix) && row.cwd===root && row.sessionId===sessionId)
      .map(([id])=>({id, at:Number(id.slice(prefix.length).split("-",1)[0]), label:"Before agent turn (tracked files)"}))
      .sort((a,b)=>b.at-a.at);
  }
  private async requireRef(sessionId: string, cwd: string, id: string): Promise<string> {
    if (!(await this.list(sessionId, cwd)).some((entry) => entry.id === id)) throw new Error("Checkpoint does not belong to this session.");
    const row=this.trusted.get(id)!;
    // Import from the host pack even if an agent removed refs, reflogs, and every original Git object.
    const pack=row.pack && this.packPath(row.cwd,row.pack);
    if(pack)await this.importPack(cwd,pack);
    let changed=false;
    if(!row.indexOid){row.indexOid=await this.snapshotIndexOid(row.cwd,row.oid);changed=true;}
    if(!row.pack && this.storagePath) {
      // Upgrade a reachable legacy snapshot before it is used. Already deleted legacy objects remain unavailable.
      row.pack=await this.protectObjects(row.cwd,row.oid,row.indexOid);changed=true;
    }
    if(changed)await this.persist();
    return row.oid;
  }
  private async importPack(cwd:string,pack:string):Promise<void> {
    const pending=exec("git",["--no-replace-objects","-c","core.hooksPath=/dev/null","-C",cwd,"index-pack","--stdin"],{timeout:15000,maxBuffer:1024});
    const source=createReadStream(pack);source.on("error",error=>pending.child.stdin?.destroy(error));
    pending.child.stdin?.on("error",()=>undefined);source.pipe(pending.child.stdin!);
    try {await pending;}finally {source.destroy();}
  }
  private packPath(cwd:string,hash:string):string|undefined {
    return this.storagePath ? join(dirname(this.storagePath),"checkpoint-objects",createHash("sha256").update(cwd).digest("hex"),`pack-${hash}.pack`) : undefined;
  }
  private async snapshotIndexOid(cwd:string,oid:string):Promise<string> {
    const subject=await this.git(cwd,["show","-s","--format=%s",oid]);
    if(!subject.startsWith("WIP on "))return oid;
    const parents=(await this.git(cwd,["rev-list","--parents","-n","1",oid])).split(/\s+/u).slice(1);
    if(parents.length===2) {
      const indexParents=(await this.git(cwd,["rev-list","--parents","-n","1",parents[1]])).split(/\s+/u).slice(1);
      // git stash create makes its index commit a child of the same base as the snapshot commit.
      if(indexParents.length===1 && indexParents[0]===parents[0])return parents[1];
    }
    return oid;
  }
  private async protectObjects(cwd:string,oid:string,indexOid:string):Promise<string|undefined> {
    if(!this.storagePath)return undefined;
    const directory=dirname(this.packPath(cwd,"placeholder")!);await mkdir(directory,{recursive:true,mode:0o700});
    // Pack only the snapshot commit and trees used by restore, rather than cloning the project's entire ancestry.
    const objects=new Set([oid,...(await this.git(cwd,["rev-list","--objects","--no-object-names",`${oid}^{tree}`])).split("\n")]);
    objects.add(indexOid);for(const object of (await this.git(cwd,["rev-list","--objects","--no-object-names",`${indexOid}^{tree}`])).split("\n"))objects.add(object);
    if([...objects].some(object=>!/^[a-f0-9]{40,64}$/u.test(object)))throw new Error("Invalid checkpoint object list.");
    // Git can leave tmp_pack/partial index files when interrupted. Keep each invocation in its own
    // private staging folder so failure cleanup never removes a pack retained by another checkpoint.
    const staging=await mkdtemp(join(directory,`.pending-${process.pid}-`));
    try {
      const pending=exec("git",["--no-replace-objects","-c","core.hooksPath=/dev/null","-c","pack.threads=1","-C",cwd,"pack-objects","--compression=1",join(staging,"pack")],{timeout:15000,maxBuffer:1024});
      pending.child.stdin?.on("error",()=>undefined);
      pending.child.stdin?.end([...objects].join("\n")+"\n");
      const hash=(await pending).stdout.trim();if(!/^[a-f0-9]{40,64}$/u.test(hash))throw new Error("Invalid checkpoint pack hash.");
      // Restore streams the pack to index-pack, which creates its own repository index. Retaining
      // Git's staging .idx would duplicate unused data; only the complete pack is published atomically.
      await rename(join(staging,`pack-${hash}.pack`),this.packPath(cwd,hash)!);
      return hash;
    } finally {await this.removePackStaging(staging);}
  }
  async preview(sessionId: string, cwd: string, id: string): Promise<{text: string; changedFiles: string[]}> {
    const oid=await this.requireRef(sessionId, cwd, id);
    const text = await this.git(cwd, ["diff", "--no-ext-diff", "--no-textconv", oid, "--", "."]);
    const names = await this.git(cwd, ["diff", "--name-only", "--no-ext-diff", "--no-textconv", oid, "--", "."]);
    return {text: this.redact(text), changedFiles: names.split("\n").filter(Boolean)};
  }
  async restore(sessionId: string, cwd: string, id: string): Promise<{ok: boolean; message?: string}> {
    const initial=this.trusted.get(id);
    let release=this.holdPack(initial?.cwd??cwd,initial?.pack);
    try {
      const target=await this.requireRef(sessionId, cwd, id);
      const row=this.trusted.get(id)!;
      if(row.pack!==initial?.pack){await release();release=this.holdPack(row.cwd,row.pack);}
      const indexOid=row.indexOid!;
      await this.capture(sessionId, cwd);
      // Capture may prune this checkpoint at a retention limit of one. Re-import its held private pack
      // after capture, immediately before restore, in case Git garbage-collected the earlier import.
      const pack=row.pack&&this.packPath(row.cwd,row.pack);
      if(pack)await this.importPack(cwd,pack);
      await this.git(cwd, ["restore", `--source=${indexOid}`, "--staged", "--", "."]);
      await this.git(cwd, ["restore", `--source=${target}`, "--worktree", "--", "."]);
      return {ok: true, message: "Tracked files restored; the previous work was saved as another checkpoint."};
    } finally {await release();}
  }
}

/** A file can grow after stat; stop reading at the cap before allocating an oversized review input. */
async function readBoundedUntrackedFile(file: FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(32 * 1024 + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}
