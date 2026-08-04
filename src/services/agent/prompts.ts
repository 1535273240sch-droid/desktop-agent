// services/agent/prompts.ts - 提示词模板
// 内置常用模板（翻译/总结/代码审查/角色扮演）+ 用户自定义模板 + CRUD + localStorage 持久化

import { logger } from "@/services/logger";

const log = logger;

// ========================= 类型定义 =========================

export type PromptCategory = "translate" | "summarize" | "code-review" | "roleplay" | "custom";

export interface PromptTemplate {
  id: string;
  /** 模板名称 */
  name: string;
  category: PromptCategory;
  description: string;
  /** 模板正文，支持 {input} / {lang} 等占位 */
  content: string;
  /** 占位符说明（key 为占位名，value 为说明） */
  placeholders?: Record<string, string>;
  /** 是否为内置（内置不可删除） */
  builtin: boolean;
  /** 创建 / 更新时间 */
  createdAt: number;
  updatedAt: number;
}

// ========================= 内置模板 =========================

const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: "builtin-translate",
    name: "翻译",
    category: "translate",
    description: "将文本翻译为指定语言",
    content:
      "请将以下文本翻译为 {lang}，保持原文的语气和格式，仅在必要时添加少量注释：\n\n{input}",
    placeholders: {
      input: "要翻译的原文",
      lang: "目标语言，如：英语、日语、法语",
    },
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "builtin-summarize",
    name: "总结",
    category: "summarize",
    description: "用要点形式总结文本",
    content:
      "请用 {count} 条要点总结以下内容，每条不超过 30 字，最后附 1 句话总结：\n\n{input}",
    placeholders: {
      input: "要总结的文本",
      count: "要点数量，默认 5",
    },
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "builtin-code-review",
    name: "代码审查",
    category: "code-review",
    description: "审查代码并提供改进建议",
    content:
      "请审查以下代码，从「正确性 / 可读性 / 性能 / 安全性」四个维度给出评价，" +
      "标注问题行号并给出修改建议，最后给出整体评分（1-10）：\n\n```\n{input}\n```",
    placeholders: {
      input: "待审查的代码",
    },
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "builtin-roleplay",
    name: "角色扮演",
    category: "roleplay",
    description: "以指定角色身份回答",
    content:
      "请你扮演「{role}」，以该角色的语气、知识背景和表达方式回答用户的问题。" +
      "保持角色设定，不要跳出角色。如果问题超出角色能力范围，可以委婉表示。\n\n用户问题：{input}",
    placeholders: {
      role: "角色名，如：苏格拉底、福尔摩斯、资深架构师",
      input: "用户的问题",
    },
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  },
];

// ========================= 持久化 =========================

const STORAGE_KEY = "desktop-agent-prompt-templates";

function loadCustom(): PromptTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PromptTemplate[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    log.warn("prompts", "load custom templates failed", e);
    return [];
  }
}

function saveCustom(templates: PromptTemplate[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch (e) {
    log.warn("prompts", "persist failed", e);
  }
}

// ========================= 状态 =========================

let customTemplates: PromptTemplate[] = loadCustom();

// ========================= 查询 =========================

/** 获取全部模板（内置 + 自定义） */
export function listTemplates(): PromptTemplate[] {
  return [...BUILTIN_TEMPLATES, ...customTemplates];
}

/** 仅获取内置模板 */
export function listBuiltinTemplates(): PromptTemplate[] {
  return [...BUILTIN_TEMPLATES];
}

/** 仅获取自定义模板 */
export function listCustomTemplates(): PromptTemplate[] {
  return [...customTemplates];
}

/** 按类别筛选 */
export function listByCategory(category: PromptCategory): PromptTemplate[] {
  return listTemplates().filter((t) => t.category === category);
}

/** 按 ID 查找 */
export function getTemplate(id: string): PromptTemplate | undefined {
  return listTemplates().find((t) => t.id === id);
}

// ========================= CRUD =========================

/**
 * 创建自定义模板
 * - id 由调用方提供或自动生成
 * - 名称不可为空
 */
export function createTemplate(input: Omit<PromptTemplate, "id" | "builtin" | "createdAt" | "updatedAt"> & {
  id?: string;
}): PromptTemplate {
  if (!input.name?.trim()) {
    throw new Error("模板名称不能为空");
  }
  const now = Date.now();
  const tpl: PromptTemplate = {
    id: input.id ?? `custom-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim(),
    category: input.category ?? "custom",
    description: input.description ?? "",
    content: input.content ?? "",
    placeholders: input.placeholders,
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
  customTemplates.push(tpl);
  saveCustom(customTemplates);
  log.info("prompts", `template created: ${tpl.id}`);
  return tpl;
}

/** 更新模板（内置模板仅可更新 content 占位符使用，不能改名称） */
export function updateTemplate(id: string, updates: Partial<Omit<PromptTemplate, "id" | "builtin">>): PromptTemplate | null {
  const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (builtin) {
    // 内置模板：只允许更新 description / content / placeholders（不持久化，会话级临时修改）
    log.warn("prompts", `builtin template ${id} updated in-memory only`);
    return {
      ...builtin,
      ...updates,
      builtin: true,
    };
  }
  const idx = customTemplates.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const updated: PromptTemplate = {
    ...customTemplates[idx],
    ...updates,
    id,
    builtin: false,
    updatedAt: Date.now(),
  };
  customTemplates[idx] = updated;
  saveCustom(customTemplates);
  log.info("prompts", `template updated: ${id}`);
  return updated;
}

/** 删除模板（内置不可删） */
export function deleteTemplate(id: string): boolean {
  const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (builtin) {
    log.warn("prompts", `cannot delete builtin template: ${id}`);
    return false;
  }
  const before = customTemplates.length;
  customTemplates = customTemplates.filter((t) => t.id !== id);
  if (customTemplates.length === before) return false;
  saveCustom(customTemplates);
  log.info("prompts", `template deleted: ${id}`);
  return true;
}

/** 复制内置模板为自定义（便于在其基础上修改） */
export function duplicateBuiltin(id: string, newName?: string): PromptTemplate | null {
  const src = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (!src) return null;
  return createTemplate({
    name: newName ?? `${src.name}（副本）`,
    category: src.category === "custom" ? "custom" : src.category,
    description: src.description,
    content: src.content,
    placeholders: src.placeholders,
  });
}

// ========================= 渲染 =========================

/**
 * 渲染模板：用 values 替换占位符
 * - 未提供值的占位符保留原样
 */
export function renderTemplate(template: PromptTemplate, values: Record<string, string>): string {
  let out = template.content;
  for (const [key, val] of Object.entries(values)) {
    out = out.replaceAll(`{${key}}`, val);
  }
  return out;
}

/** 提取模板中所有 {占位符} 名 */
export function extractPlaceholders(template: PromptTemplate): string[] {
  const set = new Set<string>();
  const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template.content)) !== null) {
    set.add(m[1]);
  }
  return Array.from(set);
}

// ========================= 导入 / 导出 =========================

/** 导出全部模板为 JSON 字符串 */
export function exportTemplates(): string {
  return JSON.stringify(listTemplates(), null, 2);
}

/** 从 JSON 字符串导入（合并：同 id 覆盖） */
export function importTemplates(json: string): number {
  let parsed: PromptTemplate[];
  try {
    parsed = JSON.parse(json) as PromptTemplate[];
    if (!Array.isArray(parsed)) throw new Error("not an array");
  } catch (e) {
    log.error("prompts", "import parse failed", e);
    throw new Error("导入失败：JSON 格式不正确");
  }
  let added = 0;
  for (const tpl of parsed) {
    if (!tpl.id || !tpl.name) continue;
    // 跳过与内置同 id 的
    if (BUILTIN_TEMPLATES.some((b) => b.id === tpl.id)) continue;
    const idx = customTemplates.findIndex((t) => t.id === tpl.id);
    const normalized: PromptTemplate = {
      ...tpl,
      builtin: false,
      createdAt: tpl.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    if (idx === -1) {
      customTemplates.push(normalized);
      added++;
    } else {
      customTemplates[idx] = normalized;
      added++;
    }
  }
  saveCustom(customTemplates);
  log.info("prompts", `imported ${added} templates`);
  return added;
}
