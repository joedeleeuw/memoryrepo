import { Agent, callable } from "agents";
import type { Env } from "./env.ts";

export type TelemetryKind = "events" | "logs" | "traces" | "metrics";
const KINDS = new Set<TelemetryKind>(["events", "logs", "traces", "metrics"]);

export class TelemetryAgent extends Agent<Env> {
  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS batches (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)`;
  }

  @callable()
  ingest(kind: TelemetryKind, payload: unknown): { stored: number } {
    if (!KINDS.has(kind)) throw new Error(`unknown telemetry kind: ${kind}`);
    this.sql`INSERT INTO batches (at, kind, payload) VALUES (${Date.now()}, ${kind}, ${JSON.stringify(payload)})`;
    return { stored: 1 };
  }

  @callable()
  recent(kind: TelemetryKind, limit: number): { id: number; at: number; kind: TelemetryKind; payload: unknown }[] {
    if (!KINDS.has(kind)) throw new Error(`unknown telemetry kind: ${kind}`);
    return this.sql<{ id: number; at: number; kind: TelemetryKind; payload: string }>`SELECT id, at, kind, payload FROM batches WHERE kind = ${kind} ORDER BY id DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`.map((batch) => ({
      id: batch.id,
      at: batch.at,
      kind: batch.kind,
      payload: JSON.parse(batch.payload) as unknown,
    }));
  }
}
