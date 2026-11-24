// Publish dist/ to the gh-pages branch (GitHub Pages: "Deploy from a branch").
// Auth: if KUNDEKAR_TOKEN_FILE (default: ./fgt.txt) exists, its token is sent
// as a one-off HTTP header and never written to any git config or URL.
// Otherwise git's normal credential manager is used.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const remote = "https://github.com/erolcanulutas/kundekar.git";
const tokenFile = resolve(root, process.env.KUNDEKAR_TOKEN_FILE ?? "fgt.txt");

const git = (args, cwd = dist) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

if (!existsSync(resolve(dist, "index.html"))) throw new Error("dist/ is missing; run npm run build first.");

const name = git(["config", "user.name"], root);
const email = git(["config", "user.email"], root);
const sha = git(["rev-parse", "--short", "HEAD"], root);

writeFileSync(resolve(dist, ".nojekyll"), "");
rmSync(resolve(dist, ".git"), { recursive: true, force: true });
git(["init", "-q", "-b", "gh-pages"]);
git(["add", "-A"]);
git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", `Deploy ${sha}`]);

const auth = [];
if (existsSync(tokenFile)) {
  const token = readFileSync(tokenFile, "utf8").trim();
  auth.push("-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
}
git([...auth, "push", "-f", "-q", remote, "gh-pages"]);
rmSync(resolve(dist, ".git"), { recursive: true, force: true });
console.log(`Deployed ${sha} to gh-pages → https://erolcanulutas.github.io/kundekar/`);
