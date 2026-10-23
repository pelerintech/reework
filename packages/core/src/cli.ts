#!/usr/bin/env node
// `reework start <agent.ts>` — start the agent module's default-exported
// definition and serve it until SIGINT/SIGTERM.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentDefinition } from "./agent-definition.ts";
import { startAgent } from "./runtime/bootstrap.ts";

const USAGE = `Usage: reework start <agent.ts> [--port 8080] [--storage ./reework.sqlite] [--host 127.0.0.1]

Starts the agent definition default-exported by <agent.ts> and serves its API.
Requires REEWORK_API_TOKEN and the model key variable named in the definition.
<agent.ts> runs with Node's type stripping: avoid enums and parameter properties.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string", default: "8080" },
      storage: { type: "string", default: "./reework.sqlite" },
      host: { type: "string", default: "127.0.0.1" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, file] = positionals;
  if (values.help || command !== "start" || !file) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const module = (await import(pathToFileURL(resolve(file)).href)) as { default?: AgentDefinition };
  if (!module.default) {
    console.error(`${file} has no default export (expected an agent definition)`);
    return 1;
  }
  const agent = await startAgent(module.default, { storagePath: resolve(values.storage) });
  const { port } = await agent.listen(Number(values.port), values.host);
  console.log(`reework: agent "${module.default.name}" listening on ${port}`);

  // First signal: stop cleanly (bounded by stop's timeout). Second signal: exit now.
  return new Promise<number>((done) => {
    let stopping = false;
    const onSignal = () => {
      if (stopping) {
        console.error("reework: second signal, exiting now");
        return done(130);
      }
      stopping = true;
      agent.stop().then(
        () => done(0),
        (error: unknown) => {
          console.error(`reework: ${error instanceof Error ? error.message : String(error)}`);
          done(1);
        },
      );
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`reework: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
