// plugins/builtin/codeExec.ts - 内置技能包：代码执行
// 直接执行代码（通过沙箱），支持 python / shell / node
// 实现：复用沙箱后端 sandbox_execute Tauri 命令

import type { SkillPack, SandboxConfig } from "@/types";

// ========================= 技能包元数据 =========================

export const pack: SkillPack = {
  id: "builtin.code-exec",
  name: "代码执行",
  description: "通过沙箱直接执行 Python / Shell / Node.js 代码",
  version: "1.0.0",
  author: "system",
  dependencies: [],
  enabled: true,
  tools: [
    {
      name: "code_exec",
      description: "在沙箱中执行代码（自动识别语言）",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "要执行的代码" },
          language: {
            type: "string",
            enum: ["python", "shell", "node"],
            default: "python",
            description: "代码语言",
          },
          timeout: {
            type: "integer",
            default: 30000,
            description: "超时时间（毫秒）",
          },
        },
        required: ["code"],
      },
      handler: "builtin:code_exec",
    },
    {
      name: "code_install",
      description: "在沙箱中安装 Python 包（需要用户确认）",
      parameters: {
        type: "object",
        properties: {
          packages: {
            type: "array",
            items: { type: "string" },
            description: "要安装的包名列表",
          },
        },
        required: ["packages"],
      },
      handler: "builtin:code_install",
    },
  ],
};

// ========================= 工具实现 =========================

export interface CodeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  language: string;
}

/** 默认沙箱配置（可被外部覆盖） */
const DEFAULT_SANDBOX: SandboxConfig = {
  enabled: true,
  memoryLimit: "2g",
  cpuLimit: "2",
  diskLimit: "10g",
  networkMode: "http-only",
  autoDestroy: true,
  timeout: 30000,
};

/** 执行代码：调用 Tauri 后端 sandbox_execute */
async function codeExec(args: Record<string, any>): Promise<CodeExecResult> {
  const code: string = String(args.code ?? "");
  const language: string = String(args.language ?? "python").toLowerCase();
  const timeout: number = Number(args.timeout ?? 30000);
  if (!code.trim()) throw new Error("code_exec: code is required");

  const langMap: Record<string, string> = {
    python: "python",
    py: "python",
    shell: "shell",
    sh: "shell",
    bash: "shell",
    node: "node",
    javascript: "node",
    js: "node",
  };
  const lang = langMap[language] ?? "python";

  const config: SandboxConfig = { ...DEFAULT_SANDBOX, timeout };

  const { invoke } = await import("@tauri-apps/api/core");
  const started = Date.now();
  const result = await invoke<{
    stdout?: string;
    stderr?: string;
    exit_code?: number;
    output?: string;
    error?: string;
  }>("sandbox_execute", {
    name: `exec-${lang}`,
    lang,
    code,
    config,
  });

  return {
    stdout: result.stdout ?? result.output ?? "",
    stderr: result.stderr ?? result.error ?? "",
    exitCode: result.exit_code ?? 0,
    durationMs: Date.now() - started,
    language: lang,
  };
}

/** 安装 Python 包：调用 Tauri 后端 sandbox_pip_install */
async function codeInstall(args: Record<string, any>): Promise<{
  installed: string[];
  output: string;
}> {
  const packages: string[] = Array.isArray(args.packages)
    ? args.packages.map(String)
    : [];
  if (packages.length === 0) throw new Error("code_install: packages is required");

  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<{ output?: string; installed?: string[] }>(
    "sandbox_pip_install",
    {
      name: "exec-python",
      packages,
      autoConfirm: false,
    },
  );
  return {
    installed: result.installed ?? packages,
    output: result.output ?? "",
  };
}

// ========================= 导出 handlers =========================

export const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  code_exec: codeExec,
  code_install: codeInstall,
};
