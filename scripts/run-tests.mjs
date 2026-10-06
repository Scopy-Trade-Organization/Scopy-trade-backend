import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
function tests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? tests(join(dir, entry.name)) : entry.name.endsWith(".test.ts") ? [join(dir, entry.name)] : []);
}
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests("src")], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
