import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { ChatAgent, MemoryAgent } from "./src/server/index.ts";

export const Memories = Cloudflare.Artifacts.Namespace("Memories", { namespace: "sleepernet-memoryrepo" });

export const App = Cloudflare.Website.Vite("App", {
  main: "./src/server/index.ts",
  domain: { name: "memoryrepo.joedeleeuw.com" },
  compatibility: { date: "2026-09-01" },
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/agents/*", "/api", "/api/*", "/auth/*"],
  },
  observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
  env: {
    MemoryAgent: Cloudflare.DurableObject<MemoryAgent>("MemoryAgent"),
    ChatAgent: Cloudflare.DurableObject<ChatAgent>("ChatAgent"),
    MEMORIES: Memories,
    OPENROUTER_API_KEY: Config.Redacted("OPENROUTER_API_KEY"),
    AUTH_SECRET: Config.Redacted("AUTH_SECRET"),
    EMAIL: Cloudflare.Email.SendEmail("Email"),
    EMAIL_FROM: Config.String("EMAIL_FROM"),
    ALLOWED_EMAIL: Config.String("ALLOWED_EMAIL"),
    MEMORY_API_KEY: Config.Redacted("MEMORY_API_KEY"),
  },
});

export default Alchemy.Stack(
  "sleepernet-memoryrepo",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const app = yield* App;
    return { url: app.url };
  }),
);
