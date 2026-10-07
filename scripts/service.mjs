import { spawnSync } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const domain = `gui/${process.getuid()}`;
const action = process.argv[2] || "status";
const target = process.argv[3];
if (target && !["host", "lan"].includes(target))
  throw Error("Unknown service target");
const xml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const launchctl = (...args) =>
  spawnSync("/bin/launchctl", args, { encoding: "utf8" });
if (process.platform !== "darwin")
  throw Error(
    "The service installer currently supports macOS. Use npm start on other systems.",
  );
for (const name of target ? [target] : ["host", "lan"]) {
  const label = `local.moru.${name}`;
  const file = join(homedir(), "Library/LaunchAgents", label + ".plist");
  if (action === "install") {
    await mkdir(dirname(file), { recursive: true });
    await mkdir(join(root, ".moru"), { recursive: true, mode: 0o700 });
    const loaded = launchctl("print", `${domain}/${label}`);
    if (loaded.status === 0) {
      console.log(`Moru ${name} service is already installed.`);
      continue;
    }
    await writeFile(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>--import</string><string>tsx</string><string>src/${name}.ts</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(root, `.moru/${name}.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, `.moru/${name}.err.log`))}</string>
</dict></plist>`,
      { mode: 0o600 },
    );
    const result = launchctl("bootstrap", domain, file);
    if (result.status !== 0)
      throw Error(result.stderr || "Service installation failed");
    console.log(`Moru ${name} service installed.`);
  } else if (action === "stop" || action === "remove") {
    const result = launchctl("bootout", `${domain}/${label}`);
    if (action === "remove") await rm(file, { force: true });
    console.log(
      result.status === 0
        ? `Moru ${name} service stopped.`
        : `Moru ${name} service is not running.`,
    );
  } else {
    const result = launchctl("print", `${domain}/${label}`);
    console.log(
      result.status === 0
        ? result.stdout
            .split("\n")
            .filter((line) =>
              /state =|pid =|path =|runs =|last exit/.test(line),
            )
            .join("\n")
        : `Moru ${name} service is not running.`,
    );
  }
}
