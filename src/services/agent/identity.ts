// services/agent/identity.ts - Agent 身份管理
// 自定义名字 + 人设描述 + 全局 System Prompt + 每会话 System Prompt
// 与 settings store（全局）+ chat store（每会话）协作

import { logger } from "@/services/logger";
import { useSettingsStore } from "@/stores/settings";
import { useChatStore } from "@/stores/chat";
import type { AppSettings } from "@/types";

const log = logger;

// ========================= 类型与预设 =========================

export interface PersonaPreset {
  id: string;
  name: string;
  /** 人设描述（agentPersona） */
  persona: string;
  /** 推荐的 System Prompt */
  systemPrompt: string;
  description: string;
}

/** 内置人设预设 */
export const PERSONA_PRESETS: PersonaPreset[] = [
  {
    id: "default-assistant",
    name: "通用助手",
    persona: "乐于助人、严谨、谦逊的通用 AI 助手。",
    systemPrompt:
      "你是一名乐于助人的 AI 助手。回答需准确、简洁，对不确定的内容明确说明。优先满足用户意图，必要时主动追问。",
    description: "适合日常问答与通用任务",
  },
  {
    id: "tech-architect",
    name: "技术架构师",
    persona: "资深技术架构师，擅长系统设计与权衡分析。",
    systemPrompt:
      "你是一名资深技术架构师。在回答技术问题时：1) 先澄清需求与约束；2) 给出 2-3 个可选方案并对比权衡；" +
      "3) 明确推荐方案及其理由；4) 标注潜在风险与扩展点。",
    description: "适合架构设计、技术选型",
  },
  {
    id: "researcher",
    name: "学术研究员",
    persona: "严谨的学术研究员，注重证据与可验证性。",
    systemPrompt:
      "你是一名严谨的学术研究员。回答需基于可验证的证据，区分事实与推测；引用来源时给出明确出处；" +
      "对未知领域明确表示「不确定」而非编造。回复使用结构化、客观的语气。",
    description: "适合学术研究、文献分析",
  },
  {
    id: "creative-writer",
    name: "创意作者",
    persona: "富有想象力的创意作者，擅长叙事与表达。",
    systemPrompt:
      "你是一名富有想象力的创意作者。在创作时注重画面感、节奏与情感共鸣，" +
      "避免陈词滥调，鼓励独特视角。在非创作任务中保持简洁实用。",
    description: "适合写作、文案、剧本",
  },
  {
    id: "code-engineer",
    name: "代码工程师",
    persona: "注重工程实践与代码质量的资深工程师。",
    systemPrompt:
      "你是一名注重工程实践的资深代码工程师。回答时：1) 代码需可直接运行，给出完整可复制片段；" +
      "2) 包含必要注释与边界处理；3) 指出潜在坑点与性能考量；4) 优先使用现代语法与最佳实践。",
    description: "适合编程、调试、代码审查",
  },
];

// ========================= 全局身份 =========================

export interface AgentIdentity {
  name: string;
  persona: string;
  systemPrompt: string;
}

/**
 * 读取全局 Agent 身份（来自 settings store）
 */
export function getGlobalIdentity(): AgentIdentity {
  const settings = useSettingsStore();
  const s = settings.settings;
  return {
    name: s.agentName,
    persona: s.agentPersona,
    systemPrompt: s.systemPrompt,
  };
}

/**
 * 更新全局 Agent 身份
 * - 任意字段可省略，仅更新提供的字段
 */
export async function updateGlobalIdentity(updates: Partial<AgentIdentity>): Promise<AgentIdentity> {
  const settings = useSettingsStore();
  if (typeof updates.name === "string") {
    settings.settings.agentName = updates.name.trim() || settings.settings.agentName;
  }
  if (typeof updates.persona === "string") {
    settings.settings.agentPersona = updates.persona;
  }
  if (typeof updates.systemPrompt === "string") {
    settings.settings.systemPrompt = updates.systemPrompt;
  }
  await settings.save();
  log.info("identity", "global identity updated", {
    name: settings.settings.agentName,
    personaLen: settings.settings.agentPersona.length,
    promptLen: settings.settings.systemPrompt.length,
  });
  return getGlobalIdentity();
}

/**
 * 应用一个人设预设到全局身份
 * - 默认不覆盖已设置的 agentName；可通过 options.forceName 强制覆盖
 */
export async function applyPersonaPreset(
  presetId: string,
  options?: { forceName?: boolean },
): Promise<PersonaPreset | null> {
  const preset = PERSONA_PRESETS.find((p) => p.id === presetId);
  if (!preset) {
    log.warn("identity", `preset not found: ${presetId}`);
    return null;
  }
  const updates: Partial<AgentIdentity> = {
    persona: preset.persona,
    systemPrompt: preset.systemPrompt,
  };
  if (options?.forceName) updates.name = preset.name;
  await updateGlobalIdentity(updates);
  log.info("identity", `applied persona preset: ${presetId}`);
  return preset;
}

// ========================= 每会话 System Prompt =========================

/**
 * 读取某个会话的 System Prompt
 * - 若会话未单独设置，回退到全局 System Prompt
 */
export function getConversationSystemPrompt(conversationId: string): string {
  const chat = useChatStore();
  const conv = chat.conversations.find((c) => c.id === conversationId);
  if (conv?.systemPrompt && conv.systemPrompt.trim()) {
    return conv.systemPrompt;
  }
  return getGlobalIdentity().systemPrompt;
}

/** 设置某会话专属 System Prompt */
export function setConversationSystemPrompt(conversationId: string, prompt: string): void {
  const chat = useChatStore();
  chat.setSystemPrompt(conversationId, prompt);
  log.info("identity", `conversation system prompt set`, { conversationId, len: prompt.length });
}

/** 清除某会话专属 System Prompt（回退到全局） */
export function clearConversationSystemPrompt(conversationId: string): void {
  const chat = useChatStore();
  chat.setSystemPrompt(conversationId, "");
  log.info("identity", `conversation system prompt cleared`, { conversationId });
}

/** 判断某会话是否设置了专属 System Prompt */
export function hasConversationSystemPrompt(conversationId: string): boolean {
  const chat = useChatStore();
  const conv = chat.conversations.find((c) => c.id === conversationId);
  return !!(conv?.systemPrompt && conv.systemPrompt.trim());
}

// ========================= 合成最终 System Prompt =========================

/**
 * 合成某会话最终生效的 System Prompt
 * - 拼接：全局人设描述 + 全局 System Prompt + 会话专属 System Prompt（如有）
 * - 用于发送给模型前的最终装配
 */
export function composeSystemPrompt(conversationId: string): string {
  const identity = getGlobalIdentity();
  const parts: string[] = [];

  if (identity.persona.trim()) {
    parts.push(`# Agent 人设\n${identity.persona.trim()}`);
  }
  if (identity.systemPrompt.trim()) {
    parts.push(`# 全局指令\n${identity.systemPrompt.trim()}`);
  }

  const chat = useChatStore();
  const conv = chat.conversations.find((c) => c.id === conversationId);
  if (conv?.systemPrompt && conv.systemPrompt.trim()) {
    parts.push(`# 本会话指令\n${conv.systemPrompt.trim()}`);
  }

  return parts.join("\n\n");
}

/**
 * 合成全局 System Prompt（无会话上下文，用于非会话场景如记忆提取）
 */
export function composeGlobalSystemPrompt(): string {
  const identity = getGlobalIdentity();
  const parts: string[] = [];
  if (identity.persona.trim()) parts.push(`# Agent 人设\n${identity.persona.trim()}`);
  if (identity.systemPrompt.trim()) parts.push(`# 全局指令\n${identity.systemPrompt.trim()}`);
  return parts.join("\n\n");
}

// ========================= 预设查询 =========================

/** 列出所有人设预设 */
export function listPersonaPresets(): PersonaPreset[] {
  return [...PERSONA_PRESETS];
}

/** 按 ID 查找预设 */
export function getPersonaPreset(id: string): PersonaPreset | undefined {
  return PERSONA_PRESETS.find((p) => p.id === id);
}

// ========================= 重置 =========================

/** 重置全局身份为默认值 */
export async function resetGlobalIdentity(): Promise<void> {
  const settings = useSettingsStore();
  settings.settings.agentName = "小助";
  settings.settings.agentPersona = "";
  settings.settings.systemPrompt = "";
  await settings.save();
  log.info("identity", "global identity reset");
}

/** 从 AppSettings 一次性批量恢复（用于备份恢复） */
export async function restoreIdentityFromSettings(s: Pick<AppSettings, "agentName" | "agentPersona" | "systemPrompt">): Promise<void> {
  const settings = useSettingsStore();
  settings.settings.agentName = s.agentName ?? settings.settings.agentName;
  settings.settings.agentPersona = s.agentPersona ?? settings.settings.agentPersona;
  settings.settings.systemPrompt = s.systemPrompt ?? settings.settings.systemPrompt;
  await settings.save();
  log.info("identity", "identity restored from settings");
}
