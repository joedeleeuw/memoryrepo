import { getAgentByName } from "agents";
import { BANK, DEFAULT_BANK, memoryName } from "../shared/banks.ts";
import { sessionUser, USER } from "./auth.ts";
import type { AskResult } from "./chat-agent.ts";
import type { Env } from "./env.ts";

const THREAD = /^[a-z0-9]{1,16}$/;
const MESSAGE = /^[\w-]{1,32}$/;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (status: number, error: string) => json({ error }, status);

type ImportedMessage = { id: string; role: string; text: string; at?: number; tz?: string };
type MemoryChange = { path: string; content: string | null };

function importedMessages(value: unknown): ImportedMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const messages: ImportedMessage[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    const message = candidate as Record<string, unknown>;
    if (typeof message.id !== "string" || !MESSAGE.test(message.id)) return null;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") return null;
    if (typeof message.text !== "string") return null;
    if (message.at !== undefined && typeof message.at !== "number") return null;
    if (message.tz !== undefined && typeof message.tz !== "string") return null;
    messages.push({ id: message.id, role: message.role, text: message.text, at: message.at, tz: message.tz });
  }
  return messages;
}

function memoryChanges(value: unknown): MemoryChange[] | null {
  if (!Array.isArray(value)) return null;
  const changes: MemoryChange[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    const change = candidate as Record<string, unknown>;
    if (typeof change.path !== "string" || change.path.startsWith("/") || change.path.includes("..") || change.path.includes("\\")) return null;
    if (typeof change.content !== "string" && change.content !== null) return null;
    changes.push({ path: change.path, content: change.content });
  }
  return changes;
}

async function handleTelemetry(request: Request, env: Env, admin: boolean, authorized: boolean): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/telemetry/")) return null;
  if (url.pathname === "/api/telemetry/recent") {
    if (!admin) return fail(401, "MEMORY_API_KEY required");
    const agent = await getAgentByName(env.TelemetryAgent, "sleepernet");
    const kind = url.searchParams.get("kind") ?? "metrics";
    const limit = Number(url.searchParams.get("limit") ?? "10");
    if (!["events", "logs", "traces", "metrics"].includes(kind) || !Number.isInteger(limit)) return fail(400, "invalid kind or limit");
    return json(await agent.recent(kind as "events" | "logs" | "traces" | "metrics", limit));
  }
  if (!authorized) return fail(401, "TELEMETRY_API_KEY required");
  const match = url.pathname.match(/^\/api\/telemetry\/(?:v1\/)?(events|logs|traces|metrics)$/);
  if (!match || request.method !== "POST") return fail(404, "not found");
  const kind = match[1] as "events" | "logs" | "traces" | "metrics";
  const agent = await getAgentByName(env.TelemetryAgent, "sleepernet");
  return json(await agent.ingest(kind, await request.json()), 202);
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api" || url.pathname === "/api/") return json(INDEX);
  const admin = !!env.MEMORY_API_KEY && request.headers.get("authorization") === `Bearer ${env.MEMORY_API_KEY}`;
  const telemetryAuthorized = !!env.TELEMETRY_API_KEY && request.headers.get("authorization") === `Bearer ${env.TELEMETRY_API_KEY}`;
  const telemetry = await handleTelemetry(request, env, admin, telemetryAuthorized);
  if (telemetry) return telemetry;

  const m = url.pathname.match(/^\/api\/users\/([^/]+)(?:\/(.*))?$/);
  if (!m) return fail(404, "not found; see GET /api");
  const [, user, rest = ""] = m;
  if (!USER.test(user!)) return fail(400, "user id must match [a-z0-9_-]{1,48}");
  if (!admin && (await sessionUser(request, env)) !== user) return fail(401, "sign in as this user: Authorization: Bearer <token> (POST /auth/start, then /auth/verify)");
  const bank = url.searchParams.get("bank") ?? DEFAULT_BANK;
  if (!BANK.test(bank)) return fail(400, "bank must match [a-z0-9_-]{1,32}");
  if (bank !== DEFAULT_BANK && !(await (await getAgentByName(env.MemoryAgent, user!)).hasBank(bank))) return fail(404, `no such bank: ${bank}`);
  const mem = memoryName(user!, bank);
  const memory = await getAgentByName(env.MemoryAgent, mem);
  const [resource, ...tail] = rest.split("/");
  const method = request.method.toUpperCase();
  const ref = url.searchParams.get("ref") ?? undefined;

  try {
    switch (`${method} ${resource}`) {
      case "POST chat": {
        const body = (await request.json().catch(() => null)) as { message?: string; thread?: string; tz?: string } | null;
        if (!body?.message?.trim()) return fail(400, 'body must be JSON: {"message": "...", "thread"?: "...", "tz"?: "Europe/Berlin"}');
        if (body.thread && !THREAD.test(body.thread)) return fail(400, "bad thread id");
        const thread = body.thread ?? (await memory.newThread()).id;
        const chat = await getAgentByName(env.ChatAgent, `${mem}.${thread}`);
        const result = (await chat.ask(body.message, body.tz)) as AskResult;
        return json({ thread, ...result });
      }
      case "GET notes":
        if (!tail[0]) return json(await memory.listNotes());
        return (await memory.getNote(tail[0])) ? json(await memory.getNote(tail[0])) : fail(404, "no such note");
      case "POST notes": {
        const body = (await request.json().catch(() => null)) as { title?: string; body?: string } | null;
        if (typeof body?.body !== "string") return fail(400, 'body must be JSON: {"title"?: "...", "body": "markdown"}');
        return json(await memory.saveNote({ title: body.title ?? "Untitled", body: body.body }), 201);
      }
      case "PUT notes": {
        if (!tail[0]) return fail(400, "PUT /notes/:id");
        const existing = (await memory.getNote(tail[0])) as { title: string; body: string } | null;
        if (!existing) return fail(404, "no such note");
        const body = (await request.json().catch(() => null)) as { title?: string; body?: string } | null;
        return json(await memory.saveNote({ id: tail[0], title: body?.title ?? existing.title, body: body?.body ?? existing.body }));
      }
      case "DELETE notes":
        if (!tail[0]) return fail(400, "DELETE /notes/:id");
        await memory.deleteNote(tail[0]);
        return json({ deleted: tail[0] });
      case "GET threads": {
        if (!tail[0]) return json(await memory.listThreads());
        if (!THREAD.test(tail[0])) return fail(400, "bad thread id");
        if (tail[1] === "metadata") return json(await memory.threadMetadata(tail[0]));
        const chat = await getAgentByName(env.ChatAgent, `${mem}.${tail[0]}`);
        return json(await chat.transcript());
      }
      case "PUT threads": {
        if (!tail[0] || !THREAD.test(tail[0])) return fail(400, "bad thread id");
        const body = (await request.json().catch(() => null)) as { title?: string; messages?: unknown; cursor?: string; metadata?: Record<string, unknown> } | null;
        const messages = importedMessages(body?.messages);
        if (!body?.title?.trim() || !messages) return fail(400, "body must include title and non-empty valid messages");
        if (body.cursor && !messages.some((message) => message.id === body.cursor)) return fail(400, "cursor must name an imported message");
        if (body.metadata && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) return fail(400, "metadata must be an object");
        return json(await memory.importThread({ id: tail[0], title: body.title, messages, cursor: body.cursor, metadata: body.metadata }));
      }
      case "GET memory": {
        const path = tail.join("/");
        if (!path) return json(await memory.tree(ref));
        const head = ref ?? (await memory.tree()).hash;
        if (!head) return fail(404, "memory is empty");
        const text = await memory.file(head, path);
        return text === null
          ? fail(404, `no such file: ${path}`)
          : new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8", "x-memory-commit": head } });
      }
      case "PUT memory": {
        const body = (await request.json().catch(() => null)) as { expectedHead?: string | null; changes?: unknown; message?: string } | null;
        const changes = memoryChanges(body?.changes);
        if ((body?.expectedHead !== null && typeof body?.expectedHead !== "string") || !changes || !body.message?.trim()) {
          return fail(400, "body must include expectedHead, changes, and message");
        }
        const outcome = await memory.applyEdits(body.expectedHead, changes, body.message);
        if (!outcome.ok) return fail(outcome.reason === "conflict" ? 409 : 500, outcome.reason);
        return json(outcome);
      }
      case "GET search": {
        const q = url.searchParams.get("q");
        return q ? json(await memory.search(q, url.searchParams.get("mode") === "any" ? "any" : "all")) : fail(400, "missing ?q=");
      }
      case "GET history":
        return json(tail[0] ? await memory.commitChanges(tail[0]) : await memory.history());
      case "POST dream":
        return json(await memory.dreamNow(), 202);
      case "GET dream":
        return json(await memory.dreamStatus());
      case "GET costs":
        return json(await memory.costs());
      default:
        return fail(404, "not found; see GET /api");
    }
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : String(error));
  }
}

const INDEX = {
  name: "markdown-memory",
  banks: "add ?bank=<name> to any route (default: main); banks are created in the UI",
  auth: "Authorization: Bearer <token>; get one with POST /auth/start {email}, then /auth/verify",
  routes: [
    "POST /api/users/:user/chat  {message, thread?, tz?}",
    "GET  /api/users/:user/notes",
    "POST /api/users/:user/notes  {title?, body}",
    "GET|PUT|DELETE /api/users/:user/notes/:id",
    "GET  /api/users/:user/threads",
    "GET|PUT /api/users/:user/threads/:thread  {title, messages, cursor?}",
    "GET  /api/users/:user/memory  ?ref=",
    "GET  /api/users/:user/memory/<path>  ?ref=",
    "PUT  /api/users/:user/memory  {expectedHead, changes, message}",
    "GET  /api/users/:user/search?q=",
    "GET  /api/users/:user/history",
    "GET  /api/users/:user/history/:commit",
    "POST /api/users/:user/dream",
    "GET  /api/users/:user/dream",
    "GET  /api/users/:user/costs",
  ],
};
