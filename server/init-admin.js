import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { setting, setSetting, transaction } from "./store.js";

// Local-only initialization. Never pass a password in command-line arguments.
async function credentials() {
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 8192) throw Error("初始化输入过长");
    }
    return JSON.parse(input);
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    const username = await terminal.question("管理员用户名：");
    process.stdout.write("管理员密码（至少12位，输入不回显）：");
    const original = terminal._writeToOutput;
    terminal._writeToOutput = () => {};
    const password = await terminal.question("");
    process.stdout.write("\n再次输入密码：");
    const confirmation = await terminal.question("");
    terminal._writeToOutput = original;
    process.stdout.write("\n");
    if (password !== confirmation) throw Error("两次密码不一致");
    return { username, password };
  } finally {
    terminal.close();
  }
}
try {
  if (setting("admin")) throw Error("管理员已存在；初始化不会覆盖现有账号。");
  const { username, password } = await credentials();
  if (
    typeof username !== "string" ||
    !username.trim() ||
    username.length > 80 ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 1024
  )
    throw Error("用户名需为1至80字，密码需为12至1024字。");
  const salt = randomBytes(16).toString("hex");
  const passwordHash = scryptSync(password, salt, 64).toString("hex");
  transaction(() => {
    if (setting("admin")) throw Error("管理员已存在；初始化不会覆盖现有账号。");
    setSetting("admin", {
      username: username.trim(),
      salt,
      password: passwordHash,
    });
  });
  console.log("管理员初始化完成。HTTP 初始化在生产环境保持关闭。");
} catch (error) {
  console.error(
    error instanceof SyntaxError
      ? "初始化输入不是有效的 JSON。"
      : error.message,
  );
  process.exitCode = 1;
}
