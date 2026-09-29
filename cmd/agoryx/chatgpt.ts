import { spawn } from "node:child_process";
import { join } from "node:path";
import { AGENT_KEY_ENV } from "../../internal/agora/actor.js";
import { JEV_CHATGPT_MODEL } from "../../internal/agora/jev.js";
import { OAuthError } from "../../internal/chatgpt/auth.js";
import { chatgptDir, hostId, planUsageOn, readAccounts, saveAccount, type ChatGptAccount } from "../../internal/chatgpt/credentials.js";
import { explainPlanError, listModels, PlanError, streamResponse } from "../../internal/chatgpt/responses.js";
import { freshAccount, SignInAgainError, signIn, signOut } from "../../internal/chatgpt/session.js";
import { CliUsageError, parseCliArgsOrThrow, type OptionSpec, type OutputWriter } from "./cli-args.js";

export const CHATGPT_COMMANDS = new Set(["chatgpt", "login", "logout"]);

export const printChatGptUsage = (write: OutputWriter = console.log): void => {
  write(
    [
      "Sign in with ChatGPT — let Agoryx use your ChatGPT plan (Plus or Pro) for its own requests, no API key.",
      "",
      "  agoryx login chatgpt [--new] [--consent] [--port N] [--no-browser]",
      "                                  Continue with ChatGPT in the browser. --new adds another account or workspace;",
      "                                  --consent asks again, to turn plan use on after declining it",
      "  agoryx chatgpt status           Who is signed in, whether plan use is on, when the token renews",
      "  agoryx chatgpt test [--model SLUG] [--prompt TEXT]",
      "                                  List the models on your plan and stream one request",
      "  agoryx logout chatgpt           End the session with OpenAI and clear the tokens here",
      "",
      `With no Jev key, rooms ask ${JEV_CHATGPT_MODEL} on your plan who a message is for and whether a second look`,
      "is worth a turn (AGORYX_JEV_MODEL picks another model, AGORYX_JEV=off turns it off; restart `agoryx up`).",
      "Usage counts toward your ChatGPT plan; review it and set a limit for Agoryx in ChatGPT → Settings → Usage.",
      `Tokens live in ${join(chatgptDir(), "accounts.json")} (owner-only); the agents Agoryx runs are never given them.`,
    ].join("\n"),
  );
};

const HELP: OptionSpec = { long: "help", short: "h", takesValue: false };
const parse = (argv: string[], specs: OptionSpec[]) => parseCliArgsOrThrow(argv, [HELP, ...specs], printChatGptUsage);

const openUrl = (url: string): void => {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // the printed URL is enough
  }
};

const until = (iso: string | null): string => {
  if (!iso) return "unknown";
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes <= 0) return "expired (renewed on the next request)";
  return minutes < 90 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`;
};

const who = (account: ChatGptAccount): string => account.email ?? account.name ?? account.subject;

const planLine = (account: ChatGptAccount): string =>
  planUsageOn(account)
    ? "on — eligible requests count toward your ChatGPT plan; manage it in ChatGPT → Settings → Usage"
    : "off — you declined it; `agoryx login chatgpt --consent` asks again";

const runLogin = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [
    { long: "new", takesValue: false },
    { long: "consent", takesValue: false },
    { long: "port", takesValue: true },
    { long: "no-browser", takesValue: false },
  ]);
  if (parsed.options.help) {
    printChatGptUsage();
    return 0;
  }
  const port = parsed.options.port ? Number(parsed.options.port) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new CliUsageError("--port takes a port number", printChatGptUsage);
  const dir = chatgptDir();
  const noBrowser = parsed.options["no-browser"] === "true";
  const { account, registered } = await signIn({
    dir,
    newAccount: parsed.options.new === "true",
    consent: parsed.options.consent === "true",
    ...(port !== undefined ? { port } : {}),
    showUrl: (url) => {
      console.log(noBrowser ? "Continue with ChatGPT — open this in a browser on this machine:" : "Continue with ChatGPT in your browser. If it did not open:");
      console.log(`  ${url}`);
      console.log("Waiting for the browser…");
    },
    openBrowser: (url) => {
      if (!noBrowser) openUrl(url);
    },
  });
  console.log(`${registered ? "Registered and signed in" : "Signed in"} as ${who(account)} (${account.clientId}).`);
  if (!planUsageOn(account)) {
    console.log("ChatGPT plan use was not granted, so Agoryx cannot make requests on your plan.");
    console.log("To turn it on: agoryx login chatgpt --consent");
    return 0;
  }
  if (!account.welcomedAt) {
    console.log("");
    console.log("You're using your ChatGPT plan.");
    console.log("Eligible usage in Agoryx uses your ChatGPT plan. Manage usage in your ChatGPT settings (Settings → Usage).");
    saveAccount(dir, { ...account, welcomedAt: new Date().toISOString() });
    console.log("");
    console.log(`With no Jev key, rooms now ask ${JEV_CHATGPT_MODEL} on your plan who a message is for and whether a second look is worth a turn`);
    console.log("(from the next `agoryx up`; AGORYX_JEV=off turns it off).");
  }
  console.log("Check it with: agoryx chatgpt test");
  return 0;
};

const runStatus = (): number => {
  const dir = chatgptDir();
  const { active, accounts } = readAccounts(dir);
  const account = active ? accounts[active] : undefined;
  if (!account) {
    console.log("Not signed in with ChatGPT. Run: agoryx login chatgpt");
    return 1;
  }
  if (!account.accessToken) {
    console.log(`Signed out (${who(account)}, ${account.clientId} is kept for the next sign-in). Run: agoryx login chatgpt`);
    return 1;
  }
  console.log(`ChatGPT: ${who(account)} (${account.clientId})`);
  console.log(`  plan use:     ${planLine(account)}`);
  console.log(`  access token: expires ${until(account.expiresAt)}; renewed automatically for 30 days after each use`);
  console.log(`  scopes:       ${account.scopes.join(" ")}`);
  console.log(`  host id:      ${hostId(dir)}`);
  const others = Object.values(accounts).filter((other) => other.clientId !== account.clientId);
  if (others.length) console.log(`  also registered: ${others.map((other) => `${who(other)} (${other.clientId})`).join(", ")}`);
  return 0;
};

const PREFERRED_TEST_MODELS = ["gpt-6-luna", "gpt-6.1-sol"];

const runTest = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [
    { long: "model", short: "m", takesValue: true },
    { long: "prompt", short: "p", takesValue: true },
  ]);
  if (parsed.options.help) {
    printChatGptUsage();
    return 0;
  }
  const account = await freshAccount(chatgptDir());
  if (!planUsageOn(account)) {
    console.log("ChatGPT plan use is off for this sign-in. To turn it on: agoryx login chatgpt --consent");
    return 1;
  }
  const models = await listModels(account.accessToken!);
  console.log(`Models on ${who(account)}'s plan (${models.length}): ${models.map((model) => model.slug).join(", ") || "none listed"}`);
  const model =
    parsed.options.model ??
    PREFERRED_TEST_MODELS.find((slug) => models.some((listed) => listed.slug === slug)) ??
    models[0]?.slug;
  if (!model) {
    console.log("No model to try: pass one with --model.");
    return 1;
  }
  process.stdout.write(`${model}: `);
  const done = await streamResponse(account.accessToken!, {
    model,
    input: parsed.options.prompt ?? "Say exactly: Hello, world!",
    onDelta: (text) => process.stdout.write(text),
  }).finally(() => process.stdout.write("\n"));
  const usage = done.usage;
  const tokens = usage ? ` · ${usage.input_tokens ?? "?"} tokens in, ${usage.output_tokens ?? "?"} out` : "";
  console.log(`  completed in ${done.ms} ms${tokens}${done.requestId ? ` · request ${done.requestId}` : ""}`);
  return 0;
};

const runLogout = async (): Promise<number> => {
  const out = await signOut(chatgptDir());
  if (!out) {
    console.log("Not signed in with ChatGPT.");
    return 0;
  }
  console.log(`Signed out ${who(out.account)}; the tokens here are cleared.`);
  if (!out.revoked) console.log("OpenAI did not confirm the session ended: to be sure, disconnect Agoryx in ChatGPT → Settings → Security and login.");
  return 0;
};

const provider = (argv: string[]): string[] => {
  const [first, ...rest] = argv;
  if (first === "chatgpt") return rest;
  if (first === undefined || first.startsWith("-")) return argv;
  throw new CliUsageError(`unknown sign-in provider '${first}' (only chatgpt)`, printChatGptUsage);
};

/** `agoryx chatgpt <login|status|test|logout>`, and `agoryx login chatgpt` / `agoryx logout chatgpt`. */
export const runChatGpt = async (command: string, argv: string[]): Promise<number> => {
  // The human's plan and sign-in: an agent's commands neither spend it nor sign the human out.
  if (process.env.AGORYX_AGENT || process.env[AGENT_KEY_ENV]) {
    console.error(`agoryx ${command}: the human's ChatGPT sign-in is not for an agent's commands; ask the human to run it`);
    return 1;
  }
  try {
    if (command === "login") return await runLogin(provider(argv));
    if (command === "logout") return await runLogout();
    const [sub, ...rest] = argv;
    switch (sub) {
      case "login":
        return await runLogin(rest);
      case "status":
        return runStatus();
      case "test":
        return await runTest(rest);
      case "logout":
        return await runLogout();
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printChatGptUsage();
        return 0;
      default:
        throw new CliUsageError(`unknown chatgpt command '${sub}'`, printChatGptUsage);
    }
  } catch (error) {
    if (error instanceof PlanError) {
      console.error(`ChatGPT: ${explainPlanError(error)}${error.requestId ? ` (request ${error.requestId})` : ""}`);
      return 1;
    }
    if (error instanceof SignInAgainError) {
      console.error(error.message);
      return 1;
    }
    if (error instanceof OAuthError) {
      const declined = error.code === "access_denied";
      console.error(declined ? "Sign-in was declined in the browser; nothing was saved." : `Sign in with ChatGPT failed (${error.code}): ${error.message}`);
      return 1;
    }
    throw error;
  }
};
