import { config } from "dotenv";
import { spawn } from "child_process";
import path from "path";

config({ path: path.join(process.cwd(), ".env.local") });

const dbUrl = process.env.DEMO_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!dbUrl) {
  console.error("Error: set DEMO_DATABASE_URL or TEST_DATABASE_URL in .env.local");
  process.exit(1);
}

process.env.DATABASE_URL = dbUrl;

const display = dbUrl.replace(/\/\/[^@]+@/, "//***@");
console.log(`demo:dev — pointing DATABASE_URL at: ${display}\n`);

const child = spawn("node_modules/.bin/next", ["dev"], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));
