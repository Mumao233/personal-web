import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createLocalPreview } from "./admin-preview.mjs";
import { decodeBase64 } from "../server/base64.js";

export const WORKBENCH =
  "C:/Users/Mumao/AppData/Local/Programs/workbench/workbench.exe";
const INSTANCE = "i-7xvfvftrswzogb3o6n05";
const REGION = "cn-guangzhou";
const common = [
  "--instance-id",
  INSTANCE,
  "--region",
  REGION,
  "--output",
  "json",
];
const remotePattern = /^\/tmp\/personal-web-admin-input\.[A-Za-z0-9]{10}$/;
const maxJSONBytes = 42 * 1024 * 1024;
const maxInputBytes = 1024 * 1024;
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

function failure(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}
const publicFailure = (error) => ({
  ok: false,
  code: error.code || "LOCAL_ERROR",
  error:
    error.safeMessage ||
    (error.code?.startsWith("ADMIN_")
      ? error.message
      : "本机管理入口执行失败；请检查本机文件和 Workbench 连接。"),
  ...(error.outcomeUnknown
    ? {
        outcomeUnknown: true,
        retry: "保留原 requestId 和原请求重试；不要另建请求，以免重复执行。",
      }
    : {}),
});
function safeFailure(code, message, extra) {
  const error = failure(code, message, extra);
  error.safeMessage = message;
  return error;
}

export function executeWorkbench(args) {
  return new Promise((resolveResult) => {
    const child = spawn(WORKBENCH, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      size = 0,
      finished = false;
    const finish = (result) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolveResult(result);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -1, stdout: "", stderr: "", timedOut: true });
    }, 150000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > 1024 * 1024) {
        child.kill();
        finish({ code: -1, stdout: "", stderr: "", oversized: true });
      } else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.on("error", () => finish({ code: -1, stdout: "", stderr: "" }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

export function parseWorkbenchResult(
  result,
  { isExec = false, isTransfer = false } = {},
) {
  if (result?.timedOut)
    throw safeFailure(
      "ADMIN_TRANSPORT_TIMEOUT",
      "Workbench 超时；服务器操作可能仍在继续。",
      { outcomeUnknown: true },
    );
  // Workbench v1.0.1 emits transfer progress only to stderr, even with
  // --output json. This exception is restricted to successful file transfers;
  // remote exec still requires its structured exit status.
  if (
    isTransfer &&
    !isExec &&
    result?.code === 0 &&
    result.stdout === "" &&
    !result.oversized
  )
    return { transferComplete: true };
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw safeFailure(
      "ADMIN_TRANSPORT_ERROR",
      "Workbench 未返回有效 JSON；原始输出已隐藏。",
      { outcomeUnknown: true },
    );
  }
  if (!object(parsed) || parsed.timed_out === true || parsed.timedOut === true)
    throw safeFailure(
      "ADMIN_TRANSPORT_TIMEOUT",
      "Workbench 远程执行超时；服务器操作可能仍在继续。",
      { outcomeUnknown: true },
    );
  if (
    result.code !== 0 ||
    (parsed.exit_code !== undefined && parsed.exit_code !== 0) ||
    (parsed.code !== undefined && parsed.code !== 0) ||
    parsed.success === false ||
    parsed.error
  )
    throw safeFailure(
      "ADMIN_TRANSPORT_ERROR",
      "Workbench 执行失败；原始错误已隐藏，以免泄露内容或凭据。",
      { outcomeUnknown: true },
    );
  if (isExec && (!Number.isInteger(parsed.exit_code) || parsed.exit_code !== 0))
    throw safeFailure(
      "ADMIN_TRANSPORT_ERROR",
      "Workbench 未提供可验证的远程退出状态。",
      { outcomeUnknown: true },
    );
  return parsed;
}

export function validateRemoteDirectory(directory) {
  if (typeof directory !== "string" || !remotePattern.test(directory))
    throw safeFailure(
      "ADMIN_REMOTE_PATH",
      "服务器返回的临时路径不符合约束，已停止操作。",
    );
  return directory;
}

async function prepareRequest(request, inputDirectory) {
  if (
    !object(request) ||
    typeof request.action !== "string" ||
    !["list", "get", "preview", "apply", "media-upload", "media-get"].includes(
      request.action,
    )
  )
    throw safeFailure("ADMIN_INPUT", "请求必须是受支持操作的 JSON 对象。");
  const copy = structuredClone(request);
  if (copy.action === "media-upload") {
    if (
      !Array.isArray(copy.files) ||
      copy.files.length < 1 ||
      copy.files.length > 20
    )
      throw safeFailure("ADMIN_INPUT", "每次需上传1至20个图片或 PDF 文件。");
    let total = 0;
    for (const file of copy.files) {
      if (!object(file)) throw safeFailure("ADMIN_INPUT", "上传文件格式无效。");
      if (file.path !== undefined) {
        if (
          Object.keys(file).some((key) => !["path", "name"].includes(key)) ||
          typeof file.path !== "string" ||
          !file.path ||
          file.path.includes("\0")
        )
          throw safeFailure(
            "ADMIN_INPUT",
            "本机上传文件仅支持 path 和可选 name。",
          );
        const path = resolve(inputDirectory, file.path);
        const info = await stat(path);
        if (!info.isFile() || info.size < 1 || info.size > 15 * 1024 * 1024)
          throw safeFailure(
            "ADMIN_INPUT",
            "上传文件必须是有效文件，且每个不超过15MiB。",
          );
        const buffer = await readFile(path);
        file.name ??= basename(path);
        file.base64 = buffer.toString("base64");
        delete file.path;
      }
      if (
        Object.keys(file).some((key) => !["name", "base64"].includes(key)) ||
        typeof file.name !== "string" ||
        file.name.length > 255 ||
        /[\\/\u0000-\u001f]/.test(file.name) ||
        !/\.(?:jpe?g|png|webp|gif|pdf)$/i.test(file.name)
      )
        throw safeFailure(
          "ADMIN_INPUT",
          "上传仅接受 JPG、PNG、WebP、GIF 或 PDF；文件名及编码必须有效。",
        );
      let size;
      try {
        size = decodeBase64(file.base64, 15 * 1024 * 1024).length;
      } catch {
        throw safeFailure("ADMIN_INPUT", "文件 base64 编码无效或超过15MiB。");
      }
      total += size;
      if (size < 1 || size > 15 * 1024 * 1024 || total > 30 * 1024 * 1024)
        throw safeFailure(
          "ADMIN_INPUT",
          "每文件最多15MiB，每次上传总量最多30MiB；请分批上传。",
        );
    }
  }
  const json = JSON.stringify(copy);
  if (
    Buffer.byteLength(json) >
    (copy.action === "media-upload" ? maxJSONBytes : maxInputBytes)
  )
    throw safeFailure("ADMIN_INPUT", "请求内容过大，请缩小单次操作范围。");
  return json;
}

// executor is dependency injection for isolated tests. It is never set by CLI,
// JSON input, environment variables or an assistant-provided command argument.
export async function runRemoteRequest(
  request,
  { executor = executeWorkbench, inputDirectory = process.cwd() } = {},
) {
  const json = await prepareRequest(request, inputDirectory);
  const localDirectory = await mkdtemp(join(tmpdir(), "personal-web-admin-"));
  const inputFile = join(localDirectory, "input.json");
  const outputFile = join(localDirectory, "output.json");
  let remoteDirectory,
    result,
    operationStarted = false,
    cleanupFailed = false;
  const exec = async (command) =>
    parseWorkbenchResult(
      await executor([
        "exec",
        ...common,
        "--timeout",
        "120",
        "--command",
        command,
      ]),
      { isExec: true },
    );
  try {
    await writeFile(inputFile, json, { mode: 0o600, flag: "wx" });
    const directoryResult = await exec(
      "umask 077; mktemp -d /tmp/personal-web-admin-input.XXXXXXXXXX",
    );
    remoteDirectory = validateRemoteDirectory(
      (directoryResult.stdout ?? directoryResult.output ?? "").trim(),
    );
    // New private directory, explicit nonexistence check, no --force overwrite.
    await exec(
      `test -d ${remoteDirectory} && test ! -L ${remoteDirectory} && test ! -e ${remoteDirectory}/input.json && test ! -L ${remoteDirectory}/input.json`,
    );
    parseWorkbenchResult(
      await executor([
        "upload",
        inputFile,
        `${remoteDirectory}/input.json`,
        ...common,
      ]),
      { isTransfer: true },
    );
    operationStarted = true;
    const executed = await exec(
      `umask 077; chmod 600 ${remoteDirectory}/input.json && sudo -n -u personal-web env DATA_DIR=/opt/personal-web/data /usr/local/bin/node /opt/personal-web/app/server/admin-cli.js < ${remoteDirectory}/input.json > ${remoteDirectory}/output.json 2> ${remoteDirectory}/error.log; admin_status=$?; printf '%s\\n' "$admin_status"`,
    );
    const statusText = (executed.stdout ?? executed.output ?? "").trim();
    if (!/^(?:0|1)$/.test(statusText))
      throw safeFailure(
        "ADMIN_REMOTE_STATUS",
        "服务器管理脚本未返回可验证状态。",
        { outcomeUnknown: true },
      );
    parseWorkbenchResult(
      await executor([
        "download",
        `${remoteDirectory}/output.json`,
        outputFile,
        ...common,
      ]),
      { isTransfer: true },
    );
    const info = await stat(outputFile);
    if (info.size > maxJSONBytes)
      throw safeFailure("ADMIN_RESPONSE_SIZE", "服务器响应超过本机读取限制。", {
        outcomeUnknown: true,
      });
    try {
      result = JSON.parse(await readFile(outputFile, "utf8"));
    } catch {
      throw safeFailure(
        "ADMIN_REMOTE_JSON",
        "服务器管理脚本未返回有效 JSON；原始输出已隐藏。",
        { outcomeUnknown: true },
      );
    }
    if (
      !object(result) ||
      typeof result.ok !== "boolean" ||
      (statusText === "0") !== result.ok
    )
      throw safeFailure("ADMIN_REMOTE_STATUS", "服务器退出状态与响应不一致。", {
        outcomeUnknown: true,
      });
  } catch (error) {
    result = publicFailure(error);
    if (!operationStarted) {
      delete result.outcomeUnknown;
      delete result.retry;
    }
  } finally {
    if (remoteDirectory) {
      try {
        validateRemoteDirectory(remoteDirectory);
        // Fixed files inside this invocation's fresh directory; no recursive rm.
        await exec(
          `rm -f -- ${remoteDirectory}/input.json ${remoteDirectory}/output.json ${remoteDirectory}/error.log && rmdir -- ${remoteDirectory}`,
        );
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await rm(localDirectory, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed)
    result.warnings = [
      ...(result.warnings || []),
      "本次临时文件未能全部清理；请让管理员检查，不要把临时内容提交到 Git。",
    ];
  return result;
}

export async function runAdminRequest(request, options = {}) {
  let result;
  try {
    result = await runRemoteRequest(request, options);
    if (result.ok && result.preview && options.previewDirectory) {
      const localPreview = await createLocalPreview(result.preview, {
        directory: options.previewDirectory,
        fetchMedia: (mediaRequest) => runRemoteRequest(mediaRequest, options),
      });
      result = { ...result, localPreview };
    }
    return result;
  } catch (error) {
    return {
      ...publicFailure(error),
      ...(result?.preview
        ? {
            preview: result.preview,
            previewReady: false,
            error:
              "本机预览生成失败，不能据此确认发布。请检查引用媒体后重新生成。",
          }
        : {}),
    };
  }
}

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" && args.length === 1) return { help: true };
    const name = { "--input": "input", "--preview-dir": "previewDirectory" }[
      arg
    ];
    if (
      !name ||
      options[name] ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw safeFailure(
        "ADMIN_ARGUMENTS",
        "仅支持 --input request.json 和可选 --preview-dir 本机目录。",
      );
    options[name] = args[++index];
  }
  if (!options.input)
    throw safeFailure("ADMIN_ARGUMENTS", "请使用 --input 指定请求 JSON 文件。");
  return options;
}

async function main() {
  let result;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          usage:
            "node scripts/admin-workbench.mjs --input request.json [--preview-dir .qa/admin-previews]",
          actions: [
            "list",
            "get",
            "preview",
            "apply",
            "media-upload",
            "media-get",
          ],
          instance: INSTANCE,
          region: REGION,
          site: "https://mumao.site/",
          note: "默认保存草稿；发布和批量操作须先预览并得到用户明确授权。",
        }) + "\n",
      );
      return;
    }
    const inputPath = resolve(options.input);
    const info = await stat(inputPath);
    if (!info.isFile() || info.size > maxJSONBytes)
      throw safeFailure("ADMIN_INPUT", "请求文件无效或超过42MiB。");
    let request;
    try {
      request = JSON.parse(await readFile(inputPath, "utf8"));
    } catch {
      throw safeFailure("ADMIN_INPUT", "请求文件不是有效 UTF-8 JSON。");
    }
    result = await runAdminRequest(request, {
      inputDirectory: resolve(inputPath, ".."),
      ...(options.previewDirectory
        ? { previewDirectory: resolve(options.previewDirectory) }
        : {}),
    });
  } catch (error) {
    result = publicFailure(error);
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
