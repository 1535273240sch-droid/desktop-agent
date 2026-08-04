// 核心类型定义

// ========== 消息与对话 ==========
export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  status: "pending" | "running" | "success" | "error" | "timeout";
  result?: any;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface ThinkingStep {
  content: string;
  timestamp: number;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  thinking?: ThinkingStep[];
  toolCalls?: ToolCall[];
  images?: string[];
  files?: AttachedFile[];
  isStreaming?: boolean;
  error?: string;
  parentId?: string;
  subAgentId?: string;
}

export interface AttachedFile {
  name: string;
  path: string;
  size: number;
  type: string;
  data?: string; // base64
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  systemPrompt?: string;
  model?: string;
  pinned?: boolean;
}

// ========== 设置与API ==========
export interface TaskApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  systemPrompt: string;
  customHeaders: Record<string, string>;
  advancedParams: Record<string, any>;
}

export interface StepApiConfig {
  apiKey: string;
  // 识图
  visionModel: string;
  // 生图
  imageModel: string;
  // TTS
  ttsModel: string;
  // Realtime
  realtimeUrl: string;
}

export interface XiaomiApiConfig {
  apiKey: string;
  appId: string;
}

export interface RateLimitConfig {
  maxConcurrent: number;
  requestsPerMinute: number;
  retryAttempts: number;
  retryBaseDelay: number;
  retryMaxDelay: number;
  queueMaxSize: number;
}

export interface ApiKeys {
  task: TaskApiConfig;
  step: StepApiConfig;
  xiaomi: XiaomiApiConfig;
}

export interface AppSettings {
  apiKeys: ApiKeys;
  rateLimits: {
    task: RateLimitConfig;
    step: RateLimitConfig;
    xiaomi: RateLimitConfig;
  };
  agentName: string;
  agentPersona: string;
  systemPrompt: string;
  voice: VoiceSettings;
  sandbox: SandboxConfig;
  theme: ThemeSettings;
  font: FontSettings;
  bootAnimation: BootAnimationSettings;
  shortcuts: Record<string, string>;
  firstRun: boolean;
  onboardingCompleted: boolean;
}

export interface VoiceSettings {
  voiceId: string;
  speed: number; // 0.5 - 2.0
  volume: number; // 0 - 100
  pitch: number; // -10 to 10
  autoInterrupt: boolean;
  ttsAutoPlay: boolean;
  realtimeEngineUrl?: string; // 可替换的语音引擎
  modulePath?: string; // 自定义语音模块路径
}

export interface SandboxConfig {
  enabled: boolean;
  memoryLimit: string;
  cpuLimit: string;
  diskLimit: string;
  networkMode: "none" | "http-only" | "full";
  autoDestroy: boolean;
  timeout: number;
}

// ========== 主题系统 ==========
export interface ThemePack {
  id: string;
  name: string;
  description?: string;
  light: Record<string, string>;
  dark: Record<string, string>;
}

export interface ThemeSettings {
  currentThemeId: string;
  darkMode: "light" | "dark" | "auto";
  customOverrides: Record<string, string>;
  auroraOrbs: boolean;
  glassEffect: boolean;
}

// ========== 开机动画模板 ==========
/**
 * 开机动画模板标识。
 * - aurora: 极光光球 + Logo 旋转环 + 进度条（默认）
 * - minimal: 单色极简，仅 Logo + 名字淡入
 * - splash: 大号 Logo + 标语居中展示，无进度条
 * - particles: 粒子环绕动画
 */
export type BootAnimationTemplate = "aurora" | "minimal" | "splash" | "particles";

export interface BootAnimationSettings {
  /** 动画模板 */
  template: BootAnimationTemplate;
  /** 动画时长（毫秒，0 表示使用模板默认） */
  durationMs: number;
  /** 是否显示跳过提示 */
  showSkipHint: boolean;
  /** 是否启用开机动画（false 则跳过整个动画） */
  enabled: boolean;
  /** 自定义 Logo URL（可选，留空使用内置 SVG） */
  customLogoUrl?: string;
}

// ========== 字体系统 ==========
export interface FontSettings {
  uiFont: string;
  codeFont: string;
  uiFontSize: number;
  codeFontSize: number;
  uiFontWeight: number;
  customFonts: string[]; // 用户导入的字体路径
}

// ========== 记忆系统 ==========
export type MemoryNodeType = "user-info" | "knowledge" | "task-record";

export interface MemoryNode {
  id: string;
  type: MemoryNodeType;
  title: string;
  summary: string;
  details: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  x?: number;
  y?: number;
}

export interface MemoryLink {
  source: string;
  target: string;
  strength: number;
  label?: string;
}

export interface MemoryGraph {
  nodes: MemoryNode[];
  links: MemoryLink[];
}

// ========== 任务规划 ==========
export type TaskStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface TaskStep {
  id: string;
  description: string;
  status: TaskStepStatus;
  result?: string;
  startedAt?: number;
  completedAt?: number;
  subAgentId?: string;
}

export interface TaskPlan {
  id: string;
  conversationId: string;
  title: string;
  steps: TaskStep[];
  status: "planning" | "executing" | "completed" | "interrupted" | "failed";
  createdAt: number;
  updatedAt: number;
}

// ========== 子Agent ==========
export interface SubAgent {
  id: string;
  name: string;
  task: string;
  status: "running" | "completed" | "failed";
  result?: string;
  startedAt: number;
  completedAt?: number;
  parentConversationId: string;
  messages: Message[];
}

// ========== 权限管理 ==========
export type AccessMode = "safe" | "full";
export type PermissionAction = "allow-once" | "allow-always" | "deny";

export interface OperationLog {
  id: string;
  timestamp: number;
  tool: string;
  action: string;
  details: string;
  mode: AccessMode;
  approved: boolean;
}

export interface RestorePoint {
  id: string;
  timestamp: number;
  operation: string;
  filePath: string;
  backupPath: string;
}

// ========== 插件系统 ==========
export interface SkillPack {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  dependencies: string[];
  tools: SkillTool[];
  enabled: boolean;
}

export interface SkillTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  handler: string; // 脚本路径或内联代码
}

export interface FunctionExtension {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  dependencies: string[];
  components: string[]; // Vue组件路径
  commands: ExtensionCommand[];
  enabled: boolean;
}

export interface ExtensionCommand {
  name: string;
  description: string;
  shortcut?: string;
  handler: string;
}

// ========== 动画包 ==========
export interface AnimationPack {
  id: string;
  name: string;
  description?: string;
  duration: number; // 毫秒
  fps: number;
  stages: AnimationStage[];
  css: string; // CSS文件内容
  svg: string; // SVG文件内容
}

export interface AnimationStage {
  name: string;
  duration: number;
  delay: number;
  easing: string;
}

// ========== 工具注册 ==========
export interface ToolDefinition {
  name: string;
  description: string;
  category: "capability" | "desktop" | "sandbox" | "sub-agent" | "plugin" | "file";
  parameters: Record<string, any>;
  handler: (args: Record<string, any>) => Promise<any>;
}

// ========== 语音模块API契约 ==========
export interface VoiceModuleProps {
  audioStream: MediaStream | null;
  state: "idle" | "listening" | "thinking" | "speaking" | "recording";
  userTranscript: string;
  aiTranscript: string;
  operationLog: string[];
  themeVars: Record<string, string>;
  agentAvatar: string;
  agentName: string;
}

export interface VoiceModuleEmits {
  onMute: () => void;
  onEnd: () => void;
  onInterrupt: () => void;
  onDesktopControl: () => void;
}
