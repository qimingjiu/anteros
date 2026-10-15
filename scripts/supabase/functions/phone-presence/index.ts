import { createPresenceIngestHandler } from "./handler.ts";

// Runs in Supabase's Deno runtime, not the bot's Node process.
Deno.serve(createPresenceIngestHandler({ env: name => Deno.env.get(name) }));
