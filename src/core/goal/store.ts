import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runsDirectory } from "../paths";
import { emptyUsage } from "../run/state";
import { terminalGoal, type GoalEvent, type GoalState } from "./state";

export function goalDirectory(directory: string): string {
  let project = resolve(directory);
  try { project = realpathSync(project); } catch { /* A new project can be created after plugin initialization. */ }
  return join(dirname(runsDirectory()), "goals", createHash("sha256").update(project).digest("hex"));
}

/** One project database; TUI controls and server scheduling share transactions, never OpenCode's tables. */
export class GoalStore {
  private db: Database;
  readonly directory: string;
  constructor(directory: string, readonly root = goalDirectory(directory)) {
    this.directory = resolve(directory);
    try { this.directory = realpathSync(this.directory); } catch { /* New project. */ }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("Invalid goal data directory");
    const file = join(root, "goals.sqlite");
    try { closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw error; }
    this.db = new Database(file, { strict: true });
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > 1) { this.db.close(); throw new Error(`Unsupported goal database version ${version}; update the plugin before opening it.`); }
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, session TEXT NOT NULL, mode TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_goal ON goals(session) WHERE mode NOT IN ('completed', 'cancelled');
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, goal TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS goal_events ON events(goal, sequence);
      CREATE TABLE IF NOT EXISTS lease (slot INTEGER PRIMARY KEY CHECK(slot=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  private decode(row: unknown): GoalState | undefined {
    if (!row) return;
    const goal = JSON.parse((row as { data: string }).data) as GoalState;
    if (goal.version !== 1 || goal.directory !== this.directory || !/^goal_[a-f0-9-]{36}$/.test(goal.id)) throw new Error("Invalid goal record");
    return goal;
  }
  get(id: string): GoalState | undefined { return this.decode(this.db.query("SELECT data FROM goals WHERE id=?").get(id)); }
  current(sessionID: string): GoalState | undefined {
    return this.decode(this.db.query("SELECT data FROM goals WHERE session=? ORDER BY (mode NOT IN ('completed','cancelled')) DESC, updated DESC LIMIT 1").get(sessionID));
  }
  runnable(): GoalState[] {
    return this.db.query("SELECT data FROM goals WHERE mode='active' OR json_extract(data, '$.operation') IS NOT NULL ORDER BY updated").all().map(row => this.decode(row)!);
  }
  notices(): GoalState[] {
    return this.db.query("SELECT data FROM goals WHERE json_extract(data, '$.notification')='pending'").all().map(row => this.decode(row)!);
  }
  history(id: string, before = Number.MAX_SAFE_INTEGER, limit = 20): GoalEvent[] {
    return (this.db.query("SELECT sequence, at, kind, data FROM events WHERE goal=? AND sequence<? ORDER BY sequence DESC LIMIT ?").all(id, before, Math.max(1, Math.min(100, limit))) as Array<GoalEvent & { data: string }>).map(row => ({ ...row, data: JSON.parse(row.data) }));
  }
  private save(goal: GoalState, kind: string, data: unknown, now: number) {
    goal.updatedAt = now;
    this.db.query("INSERT INTO goals VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode, updated=excluded.updated, data=excluded.data")
      .run(goal.id, goal.sessionID, goal.mode, now, JSON.stringify(goal));
    this.db.query("INSERT INTO events(goal,at,kind,data) VALUES(?,?,?,?)").run(goal.id, now, kind, JSON.stringify(data ?? null));
  }
  create(input: Pick<GoalState, "sessionID" | "objective" | "agent" | "model"> & { criteria?: string[] }, now = Date.now()): GoalState {
    return this.db.transaction(() => {
      if (!input.objective.trim() || input.objective.length > 50_000) throw new Error("Provide a goal objective of 1–50,000 characters");
      const existing = this.current(input.sessionID);
      if (existing && !terminalGoal(existing)) throw new Error("This session already has a goal. Edit, resume, or stop it first.");
      const goal: GoalState = { version: 1, id: `goal_${randomUUID()}`, directory: this.directory,
        sessionID: input.sessionID, objective: input.objective.trim(), originalObjective: input.objective.trim(), objectiveRevision: 1, generation: 1,
        agent: input.agent, model: input.model, criteria: input.criteria ?? [], mode: "active", stage: input.criteria?.length ? "verifying" : "defining",
        createdAt: now, updatedAt: now, cycle: 0, nextWakeAt: 0, failures: 0, summary: "Goal accepted; preparing acceptance checks.", evidence: [], usage: emptyUsage() };
      this.save(goal, "created", { objective: goal.objective, criteria: goal.criteria }, now);
      return goal;
    }).immediate();
  }
  /** All read-modify-write operations, including late callbacks, run under a write transaction. */
  change(id: string, kind: string, update: (goal: GoalState) => boolean | void, data?: unknown, now = Date.now()): GoalState | undefined {
    return this.db.transaction(() => {
      const goal = this.get(id);
      if (!goal || update(goal) === false) return undefined;
      this.save(goal, kind, data, now);
      return goal;
    }).immediate();
  }
  control(id: string, action: "pause" | "resume" | "stop" | "edit", objective?: string): GoalState {
    if (!["pause", "resume", "stop", "edit"].includes(action)) throw new Error("Invalid goal control");
    const changed = this.change(id, action, goal => {
      if (terminalGoal(goal)) throw new Error("This goal has ended. Start a new goal instead.");
      if (action === "edit" && (!objective?.trim() || objective.length > 50_000)) throw new Error("Provide the revised objective");
      goal.generation++;
      goal.mode = action === "stop" ? "cancelled" : action === "pause" ? "paused" : "active";
      goal.reason = action === "pause" ? "Paused by the user; cancelling owned work." : action === "stop" ? "Stopped by the user; cancelling owned work." : undefined;
      goal.nextWakeAt = 0; goal.failures = 0; goal.notification = undefined;
      goal.waiting = undefined; goal.noticeKey = undefined;
      goal.evidence = []; goal.verifiedAt = undefined; goal.fingerprint = undefined;
      goal.plan = undefined; goal.stage = goal.criteria.length ? "verifying" : goal.draftContract ? "reviewing" : "defining";
      if (action === "edit") {
        goal.objective = objective!.trim(); goal.objectiveRevision++; goal.criteria = []; goal.stage = "defining";
        goal.draftContract = undefined; goal.sources = undefined; goal.contractRejections = 0;
        goal.lastRunID = undefined; goal.lastExecutionRunID = undefined; goal.lastExecutionResult = undefined;
        goal.summary = "Objective revised by the user; deriving a new contract from the objective and its specification only.";
      }
    }, { objective });
    if (!changed) throw new Error("Goal not found");
    return changed;
  }
  claim(owner: string, now: number, ttl: number): boolean {
    return this.db.transaction(() => {
      const lease = this.db.query("SELECT owner, expires FROM lease WHERE slot=1").get() as { owner: string; expires: number } | null;
      if (lease && lease.owner !== owner && lease.expires > now) return false;
      this.db.query("INSERT INTO lease VALUES(1,?,?) ON CONFLICT(slot) DO UPDATE SET owner=excluded.owner, expires=excluded.expires").run(owner, now + ttl);
      return true;
    }).immediate();
  }
  owns(owner: string, now = Date.now()): boolean {
    return !!this.db.query("SELECT 1 FROM lease WHERE slot=1 AND owner=? AND expires>?").get(owner, now);
  }
  liveOwner(now = Date.now()): boolean { return !!this.db.query("SELECT 1 FROM lease WHERE slot=1 AND expires>?").get(now); }
  release(owner: string) { this.db.query("DELETE FROM lease WHERE slot=1 AND owner=?").run(owner); }
}
