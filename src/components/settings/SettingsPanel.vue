<template>
  <div class="settings-overlay" @click.self="close">
    <div class="settings-panel glass-panel">
      <!-- 头部 -->
      <div class="sp-header" data-tauri-drag-region>
        <h2 class="sp-title">设置</h2>
        <button class="sp-close" type="button" title="关闭" @click="close">
          <svg width="14" height="14" viewBox="0 0 14 14">
            <line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="sp-body">
        <!-- 左侧导航 -->
        <nav class="sp-nav">
          <button
            v-for="c in categories"
            :key="c.key"
            class="nav-item"
            :class="{ active: active === c.key }"
            type="button"
            @click="active = c.key"
          >
            <span class="nav-icon">{{ c.icon }}</span>
            <span class="nav-label">{{ c.label }}</span>
          </button>
        </nav>

        <!-- 右侧内容 -->
        <div class="sp-content">
          <!-- ========== API 配置 ========== -->
          <div v-show="active === 'api'" class="page">
            <h3 class="page-title">API 配置</h3>

            <!-- 任务 API -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">任务 API</span>
                <span class="section-tag">核心对话</span>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span class="field-label">Base URL</span>
                  <input v-model="s.apiKeys.task.baseUrl" class="input" type="text" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">API Key</span>
                  <input v-model="s.apiKeys.task.apiKey" class="input" type="password" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">Model</span>
                  <input v-model="s.apiKeys.task.model" class="input" type="text" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">Temperature ({{ s.apiKeys.task.temperature }})</span>
                  <input
                    v-model.number="s.apiKeys.task.temperature"
                    class="range"
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    @change="saveSettings"
                  />
                </label>
                <label class="field">
                  <span class="field-label">Top P ({{ s.apiKeys.task.topP }})</span>
                  <input
                    v-model.number="s.apiKeys.task.topP"
                    class="range"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    @change="saveSettings"
                  />
                </label>
                <label class="field">
                  <span class="field-label">Max Tokens</span>
                  <input
                    v-model.number="s.apiKeys.task.maxTokens"
                    class="input"
                    type="number"
                    @change="saveSettings"
                  />
                </label>
                <label class="field field-full">
                  <span class="field-label">System Prompt</span>
                  <textarea
                    v-model="s.apiKeys.task.systemPrompt"
                    class="textarea"
                    rows="3"
                    @change="saveSettings"
                  />
                </label>
              </div>

              <!-- 限流配置 -->
              <div class="rate-limit-block">
                <div class="block-label">限流配置</div>
                <div class="form-grid form-grid-3">
                  <label class="field">
                    <span class="field-label">最大并发</span>
                    <input
                      v-model.number="s.rateLimits.task.maxConcurrent"
                      class="input"
                      type="number"
                      min="1"
                      @change="saveSettings"
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">每分钟请求数</span>
                    <input
                      v-model.number="s.rateLimits.task.requestsPerMinute"
                      class="input"
                      type="number"
                      min="1"
                      @change="saveSettings"
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">重试次数</span>
                    <input
                      v-model.number="s.rateLimits.task.retryAttempts"
                      class="input"
                      type="number"
                      min="0"
                      @change="saveSettings"
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">基础重试延迟 (ms)</span>
                    <input
                      v-model.number="s.rateLimits.task.retryBaseDelay"
                      class="input"
                      type="number"
                      min="0"
                      @change="saveSettings"
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">最大重试延迟 (ms)</span>
                    <input
                      v-model.number="s.rateLimits.task.retryMaxDelay"
                      class="input"
                      type="number"
                      min="0"
                      @change="saveSettings"
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">队列最大长度</span>
                    <input
                      v-model.number="s.rateLimits.task.queueMaxSize"
                      class="input"
                      type="number"
                      min="1"
                      @change="saveSettings"
                    />
                  </label>
                </div>
              </div>
            </section>

            <!-- 阶跃 API -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">阶跃 API</span>
                <span class="section-tag">识图/生图/语音</span>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span class="field-label">API Key</span>
                  <input v-model="s.apiKeys.step.apiKey" class="input" type="password" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">识图模型</span>
                  <input v-model="s.apiKeys.step.visionModel" class="input" type="text" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">生图模型</span>
                  <input v-model="s.apiKeys.step.imageModel" class="input" type="text" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">TTS 模型</span>
                  <input v-model="s.apiKeys.step.ttsModel" class="input" type="text" @change="saveSettings" />
                </label>
                <label class="field field-full">
                  <span class="field-label">Realtime URL</span>
                  <input v-model="s.apiKeys.step.realtimeUrl" class="input" type="text" @change="saveSettings" />
                </label>
              </div>
              <div class="rate-limit-block">
                <div class="block-label">限流配置</div>
                <div class="form-grid form-grid-3">
                  <label class="field">
                    <span class="field-label">最大并发</span>
                    <input
                      v-model.number="s.rateLimits.step.maxConcurrent"
                      class="input"
                      type="number"
                      min="1"
                      @change="saveSettings"
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">每分钟请求数</span>
                    <input
                      v-model.number="s.rateLimits.step.requestsPerMinute"
                      class="input"
                      type="number"
                      min="1"
                      @change="saveSettings"
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">重试次数</span>
                    <input
                      v-model.number="s.rateLimits.step.retryAttempts"
                      class="input"
                      type="number"
                      min="0"
                      @change="saveSettings"
                    />
                  </label>
                </div>
              </div>
            </section>

            <!-- 小米 API -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">小米 API</span>
                <span class="section-tag">IoT 控制</span>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span class="field-label">API Key</span>
                  <input v-model="s.apiKeys.xiaomi.apiKey" class="input" type="password" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">App ID</span>
                  <input v-model="s.apiKeys.xiaomi.appId" class="input" type="text" @change="saveSettings" />
                </label>
              </div>
              <div class="rate-limit-block">
                <div class="block-label">限流配置</div>
                <div class="form-grid form-grid-3">
                  <label class="field">
                    <span class="field-label">最大并发</span>
                    <input
                      v-model.number="s.rateLimits.xiaomi.maxConcurrent"
                      class="input"
                      type="number"
                      min="1"
                      @change="saveSettings"
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">每分钟请求数</span>
                    <input
                      v-model.number="s.rateLimits.xiaomi.requestsPerMinute"
                      class="input"
                      type="number"
                      min="1"
                      @change="saveSettings"
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">重试次数</span>
                    <input
                      v-model.number="s.rateLimits.xiaomi.retryAttempts"
                      class="input"
                      type="number"
                      min="0"
                      @change="saveSettings"
                    />
                  </label>
                </div>
              </div>
            </section>
          </div>

          <!-- ========== 语音设置 ========== -->
          <div v-show="active === 'voice'" class="page">
            <h3 class="page-title">语音设置</h3>

            <!-- 音色选择 -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">音色选择</span>
                <button class="btn-mini" type="button" :disabled="voiceStore.voicesLoading" @click="refreshVoices">
                  {{ voiceStore.voicesLoading ? '加载中...' : '刷新音色' }}
                </button>
              </div>
              <div v-if="voiceStore.voiceList.length === 0" class="empty-tip">
                暂无音色，点击"刷新音色"从阶跃 API 获取
              </div>
              <div v-else class="voice-grid">
                <div
                  v-for="v in voiceStore.voiceList"
                  :key="v.id"
                  class="voice-card"
                  :class="{ active: voiceStore.currentVoiceId === v.id }"
                  @click="selectVoice(v.id)"
                >
                  <div class="voice-info">
                    <div class="voice-name">{{ v.name }}</div>
                    <div class="voice-meta">
                      <span class="voice-gender" :class="`gender-${v.gender}`">{{ genderLabel(v.gender) }}</span>
                      <span class="voice-lang">{{ v.language }}</span>
                    </div>
                    <div v-if="v.description" class="voice-desc">{{ v.description }}</div>
                  </div>
                  <button
                    class="preview-btn-small"
                    type="button"
                    title="试听"
                    :disabled="voiceStore.ttsState === 'playing'"
                    @click.stop="previewVoice(v.id)"
                  >
                    <span v-if="voiceStore.ttsState === 'playing'">●</span>
                    <span v-else>▶</span>
                  </button>
                </div>
              </div>
            </section>

            <!-- TTS 参数 -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">TTS 参数</span>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span class="field-label">语速 ({{ s.voice.speed.toFixed(1) }}x)</span>
                  <input
                    v-model.number="s.voice.speed"
                    class="range"
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.1"
                    @change="saveSettings"
                  />
                </label>
                <label class="field">
                  <span class="field-label">音量 ({{ s.voice.volume }})</span>
                  <input
                    v-model.number="s.voice.volume"
                    class="range"
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    @change="saveSettings"
                  />
                </label>
                <label class="field">
                  <span class="field-label">音调 ({{ s.voice.pitch }})</span>
                  <input
                    v-model.number="s.voice.pitch"
                    class="range"
                    type="range"
                    min="-10"
                    max="10"
                    step="1"
                    @change="saveSettings"
                  />
                </label>
              </div>
              <div class="toggle-row">
                <label class="switch-row">
                  <label class="switch">
                    <input v-model="s.voice.ttsAutoPlay" type="checkbox" @change="saveSettings" />
                    <span class="switch-slider" />
                  </label>
                  <span>AI 回复自动播报</span>
                </label>
                <label class="switch-row">
                  <label class="switch">
                    <input v-model="s.voice.autoInterrupt" type="checkbox" @change="saveSettings" />
                    <span class="switch-slider" />
                  </label>
                  <span>用户说话时自动打断 AI</span>
                </label>
              </div>
            </section>

            <!-- Realtime 引擎 -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">实时语音引擎</span>
                <span class="section-tag">可替换</span>
              </div>
              <div class="form-grid">
                <label class="field field-full">
                  <span class="field-label">Realtime 引擎 URL</span>
                  <input v-model="s.voice.realtimeEngineUrl" class="input" type="text" placeholder="留空使用默认 wss://api.stepfun.com/v1/realtime" @change="saveSettings" />
                </label>
                <label class="field field-full">
                  <span class="field-label">自定义语音模块路径（可选）</span>
                  <input v-model="s.voice.modulePath" class="input" type="text" placeholder="如 @/components/voice/MyVoiceModule.vue" @change="saveSettings" />
                </label>
              </div>
            </section>
          </div>

          <!-- ========== 外观主题 ========== -->
          <div v-show="active === 'theme'" class="page" >
            <h3 class="page-title">外观主题</h3>

            <!-- 主题列表 + 导入 -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">主题列表</span>
                <button class="btn-mini" type="button" @click="importTheme">+ 导入主题</button>
              </div>
              <div class="theme-grid">
                <div
                  v-for="t in themeStore.themes"
                  :key="t.id"
                  class="theme-card"
                  :class="{ active: s.theme.currentThemeId === t.id }"
                  @click="switchTheme(t.id)"
                >
                  <div class="theme-preview" :style="themePreviewStyle(t)" />
                  <div class="theme-name">{{ t.name }}</div>
                  <div v-if="t.description" class="theme-desc">{{ t.description }}</div>
                  <button
                    v-if="t.id !== 'aurora-glass'"
                    class="theme-del"
                    type="button"
                    title="删除主题"
                    @click.stop="deleteTheme(t.id)"
                  >×</button>
                </div>
              </div>
            </section>

            <!-- 可视化编辑器 -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">可视化编辑器</span>
                <button class="btn-mini" type="button" @click="resetOverrides">重置</button>
              </div>

              <div class="editor-layout">
                <div class="editor-controls">
                  <div class="block-label">颜色调色板</div>
                  <div class="color-grid">
                    <div
                      v-for="ck in colorKeys"
                      :key="ck.key"
                      class="color-item"
                    >
                      <label class="color-label">{{ ck.label }}</label>
                      <div class="color-input-wrap">
                        <input
                          :value="getColor(ck.key)"
                          class="color-input"
                          type="color"
                          @input="setColor(ck.key, ($event.target as HTMLInputElement).value)"
                        />
                        <span class="color-value">{{ getColor(ck.key) }}</span>
                      </div>
                    </div>
                  </div>

                  <div class="block-label" style="margin-top:14px">滑动条参数</div>
                  <div class="slider-grid">
                    <label class="field">
                      <span class="field-label">玻璃模糊 ({{ glassBlur }}px)</span>
                      <input
                        v-model.number="glassBlur"
                        class="range"
                        type="range"
                        min="0"
                        max="40"
                        step="1"
                      />
                    </label>
                    <label class="field">
                      <span class="field-label">玻璃饱和 ({{ glassSaturate }}%)</span>
                      <input
                        v-model.number="glassSaturate"
                        class="range"
                        type="range"
                        min="100"
                        max="200"
                        step="5"
                      />
                    </label>
                    <label class="field">
                      <span class="field-label">玻璃透明度 ({{ glassOpacity }}%)</span>
                      <input
                        v-model.number="glassOpacity"
                        class="range"
                        type="range"
                        min="0"
                        max="100"
                        step="5"
                      />
                    </label>
                  </div>
                </div>

                <!-- 实时预览 -->
                <div class="preview-pane" :style="previewStyle">
                  <div class="preview-card">
                    <div class="preview-title">实时预览</div>
                    <div class="preview-text">主要文字 Secondary</div>
                    <button class="preview-btn">主题按钮</button>
                    <input class="preview-input" placeholder="输入框预览" />
                  </div>
                </div>
              </div>
            </section>

            <!-- 字体设置 -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">字体设置</span>
                <button class="btn-mini" type="button" @click="importFontFile">+ 导入本地字体</button>
              </div>
              <div class="form-grid form-grid-2">
                <label class="field">
                  <span class="field-label">界面字体</span>
                  <input v-model="s.font.uiFont" class="input" type="text" placeholder="默认系统字体" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">代码字体</span>
                  <input v-model="s.font.codeFont" class="input" type="text" placeholder="Fira Code / JetBrains Mono" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">界面字号 ({{ s.font.uiFontSize }}px)</span>
                  <input
                    v-model.number="s.font.uiFontSize"
                    class="range"
                    type="range"
                    min="11"
                    max="20"
                    step="1"
                    @change="saveSettings"
                  />
                </label>
                <label class="field">
                  <span class="field-label">代码字号 ({{ s.font.codeFontSize }}px)</span>
                  <input
                    v-model.number="s.font.codeFontSize"
                    class="range"
                    type="range"
                    min="11"
                    max="20"
                    step="1"
                    @change="saveSettings"
                  />
                </label>
                <label class="field">
                  <span class="field-label">界面字重 ({{ s.font.uiFontWeight }})</span>
                  <input
                    v-model.number="s.font.uiFontWeight"
                    class="range"
                    type="range"
                    min="100"
                    max="700"
                    step="100"
                    @change="saveSettings"
                  />
                </label>
              </div>

              <!-- 已导入的自定义字体列表 -->
              <div v-if="s.font.customFonts.length > 0" class="custom-font-list">
                <div class="block-label">已导入的本地字体</div>
                <div
                  v-for="(path, i) in s.font.customFonts"
                  :key="path"
                  class="custom-font-item"
                >
                  <span class="cf-name" :title="path">{{ basename(path) }}</span>
                  <button class="cf-apply" type="button" @click="applyFontToUi(basename(path))">应用到界面</button>
                  <button class="cf-apply" type="button" @click="applyFontToCode(basename(path))">应用到代码</button>
                  <button class="cf-remove" type="button" title="移除" @click="removeFont(i)">×</button>
                </div>
              </div>
            </section>
          </div>

          <!-- ========== 开机动画 ========== -->
          <div v-show="active === 'boot'" class="page">
            <h3 class="page-title">开机动画</h3>

            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">启用与时长</span>
              </div>
              <div class="toggle-row">
                <label class="switch-row">
                  <label class="switch">
                    <input v-model="s.bootAnimation.enabled" type="checkbox" @change="saveSettings" />
                    <span class="switch-slider" />
                  </label>
                  <span>启用开机动画（关闭则直接进入主界面）</span>
                </label>
                <label class="switch-row">
                  <label class="switch">
                    <input v-model="s.bootAnimation.showSkipHint" type="checkbox" @change="saveSettings" />
                    <span class="switch-slider" />
                  </label>
                  <span>显示跳过提示</span>
                </label>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span class="field-label">动画时长 ({{ s.bootAnimation.durationMs }}ms)</span>
                  <input
                    v-model.number="s.bootAnimation.durationMs"
                    class="range"
                    type="range"
                    min="600"
                    max="4000"
                    step="100"
                    @change="saveSettings"
                  />
                </label>
                <label class="field field-full">
                  <span class="field-label">自定义 Logo URL（可选，留空使用内置 SVG）</span>
                  <input
                    v-model="s.bootAnimation.customLogoUrl"
                    class="input"
                    type="text"
                    placeholder="https://example.com/logo.svg"
                    @change="saveSettings"
                  />
                </label>
              </div>
            </section>

            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">动画模板</span>
              </div>
              <div class="boot-tpl-grid">
                <button
                  v-for="t in bootTemplates"
                  :key="t.key"
                  type="button"
                  class="boot-tpl-card"
                  :class="{ active: s.bootAnimation.template === t.key }"
                  @click="selectBootTemplate(t.key)"
                >
                  <div class="boot-tpl-preview" :class="`tpl-${t.key}`">
                    <span class="tpl-mock-orb orb-1" />
                    <span class="tpl-mock-orb orb-2" />
                    <span class="tpl-mock-ring" />
                    <span class="tpl-mock-logo">{{ (s.agentName || 'A').trim().charAt(0).toUpperCase() }}</span>
                  </div>
                  <div class="boot-tpl-info">
                    <div class="boot-tpl-name">{{ t.label }}</div>
                    <div class="boot-tpl-desc">{{ t.desc }}</div>
                  </div>
                </button>
              </div>
            </section>
          </div>

          <!-- ========== 扩展管理 ========== -->
          <div v-show="active === 'extension'" class="page">
            <h3 class="page-title">扩展管理</h3>

            <!-- 技能包 -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">技能包 (Skill Packs)</span>
                <button class="btn-mini" type="button" @click="importSkillPack">+ 导入技能包</button>
              </div>
              <div v-if="skillPacks.length === 0" class="empty-tip">暂无技能包，点击导入</div>
              <div
                v-for="sp in skillPacks"
                :key="sp.id"
                class="ext-item"
              >
                <div class="ext-main">
                  <div class="ext-name">{{ sp.name }}
                    <span class="ext-version">v{{ sp.version }}</span>
                  </div>
                  <div class="ext-desc">{{ sp.description }}</div>
                  <div class="ext-meta">作者: {{ sp.author }} · 工具数: {{ sp.tools.length }}</div>
                </div>
                <div class="ext-actions">
                  <label class="switch">
                    <input
                      :checked="sp.enabled"
                      type="checkbox"
                      @change="toggleSkillPack(sp.id)"
                    />
                    <span class="switch-slider" />
                  </label>
                </div>
              </div>
            </section>

            <!-- 功能扩展 -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">功能扩展 (Function Extensions)</span>
                <button class="btn-mini" type="button" @click="importExtension">+ 导入扩展</button>
              </div>
              <div v-if="functionExtensions.length === 0" class="empty-tip">暂无功能扩展</div>
              <div
                v-for="fe in functionExtensions"
                :key="fe.id"
                class="ext-item"
              >
                <div class="ext-main">
                  <div class="ext-name">{{ fe.name }}
                    <span class="ext-version">v{{ fe.version }}</span>
                  </div>
                  <div class="ext-desc">{{ fe.description }}</div>
                  <div class="ext-meta">作者: {{ fe.author }} · 命令数: {{ fe.commands.length }}</div>
                </div>
                <div class="ext-actions">
                  <label class="switch">
                    <input
                      :checked="fe.enabled"
                      type="checkbox"
                      @change="toggleExtension(fe.id)"
                    />
                    <span class="switch-slider" />
                  </label>
                </div>
              </div>
            </section>
          </div>

          <!-- ========== 沙箱配置 ========== -->
          <div v-show="active === 'sandbox'" class="page">
            <h3 class="page-title">沙箱配置</h3>

            <!-- Docker 状态 -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">Docker 状态</span>
                <span class="docker-status" :class="docker.available ? 'ok' : 'err'">
                  <span class="docker-dot" />
                  {{ docker.available ? "可用" : "不可用" }}
                </span>
              </div>
              <div v-if="docker.available" class="docker-info">
                <div class="info-row"><span>版本</span><span>{{ docker.version || "-" }}</span></div>
                <div class="info-row"><span>容器数</span><span>{{ docker.containers }}</span></div>
                <div class="info-row"><span>运行中</span><span>{{ docker.running }}</span></div>
              </div>
              <div v-else class="empty-tip">Docker 不可用，请确保已安装并启动 Docker 服务</div>
            </section>

            <!-- 资源限制 -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">资源限制</span>
              </div>
              <div class="form-grid form-grid-2">
                <label class="field">
                  <span class="field-label">内存限制</span>
                  <input v-model="s.sandbox.memoryLimit" class="input" type="text" placeholder="2g" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">CPU 限制</span>
                  <input v-model="s.sandbox.cpuLimit" class="input" type="text" placeholder="2" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">磁盘限制</span>
                  <input v-model="s.sandbox.diskLimit" class="input" type="text" placeholder="10g" @change="saveSettings" />
                </label>
                <label class="field">
                  <span class="field-label">超时 (ms)</span>
                  <input v-model.number="s.sandbox.timeout" class="input" type="number" min="1000" @change="saveSettings" />
                </label>
              </div>
              <div class="toggle-row">
                <label class="switch-row">
                  <label class="switch">
                    <input v-model="s.sandbox.enabled" type="checkbox" @change="saveSettings" />
                    <span class="switch-slider" />
                  </label>
                  <span>启用沙箱</span>
                </label>
                <label class="switch-row">
                  <label class="switch">
                    <input v-model="s.sandbox.autoDestroy" type="checkbox" @change="saveSettings" />
                    <span class="switch-slider" />
                  </label>
                  <span>任务完成后自动销毁</span>
                </label>
              </div>
            </section>

            <!-- 网络模式 -->
            <section class="cfg-section glass">
              <div class="section-head">
                <span class="section-name">网络模式</span>
              </div>
              <div class="net-modes">
                <label
                  v-for="m in [
                    { v: 'none', label: '无网络', desc: '完全隔离，不可访问任何网络' },
                    { v: 'http-only', label: '仅 HTTP', desc: '仅允许 HTTP/HTTPS 出站' },
                    { v: 'full', label: '完全访问', desc: '不限制网络访问' },
                  ]"
                  :key="m.v"
                  class="net-card"
                  :class="{ active: s.sandbox.networkMode === m.v }"
                >
                  <input
                    v-model="s.sandbox.networkMode"
                    type="radio"
                    :value="m.v"
                    @change="saveSettings"
                  />
                  <div class="net-card-name">{{ m.label }}</div>
                  <div class="net-card-desc">{{ m.desc }}</div>
                </label>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { useThemeStore } from "@/stores/theme";
import { useVoiceStore } from "@/stores/voice";
import { fontLoader } from "@/services/fontLoader";
import type { ThemePack, SkillPack, FunctionExtension } from "@/types";

const settingsStore = useSettingsStore();
const themeStore = useThemeStore();
const voiceStore = useVoiceStore();

// 直接绑定到 store 的 reactive settings
const s = settingsStore.settings;

const categories = [
  { key: "api", label: "API 配置", icon: "🔌" },
  { key: "voice", label: "语音设置", icon: "🎙" },
  { key: "theme", label: "外观主题", icon: "🎨" },
  { key: "boot", label: "开机动画", icon: "✨" },
  { key: "extension", label: "扩展管理", icon: "🧩" },
  { key: "sandbox", label: "沙箱配置", icon: "📦" },
] as const;

type CategoryKey = (typeof categories)[number]["key"];
const active = ref<CategoryKey>("api");

async function saveSettings() {
  await settingsStore.save();
  themeStore.applyTheme();
  voiceStore.syncConfig();
}

// ===== 音色管理 =====
async function refreshVoices() {
  voiceStore.init();
  await voiceStore.loadVoices(true);
}

async function selectVoice(voiceId: string) {
  await voiceStore.selectVoice(voiceId);
}

async function previewVoice(voiceId: string) {
  await voiceStore.previewVoice(voiceId);
}

function genderLabel(g: string): string {
  if (g === "male") return "男声";
  if (g === "female") return "女声";
  return "中性";
}

// ===== 字体导入 =====
function importFontFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".ttf,.otf,.woff,.woff2";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      // Tauri 环境下读取文件路径
      const path = (file as any).path ?? file.name;
      // 加载到文档
      const loaded = await fontLoader.loadFromFile(path);
      // 加入 customFonts 数组
      if (!s.font.customFonts.includes(path)) {
        s.font.customFonts.push(path);
        await saveSettings();
      }
      console.info(`[font] 字体 ${loaded.family} 加载成功`);
    } catch (e) {
      console.error("[font] 导入字体失败:", e);
      // 降级：把文件名作为字体名添加到 customFonts，让用户手动指定路径
      const fileName = (file as any).path ?? file.name;
      if (!s.font.customFonts.includes(fileName)) {
        s.font.customFonts.push(fileName);
        await saveSettings();
      }
    }
  };
  input.click();
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

async function applyFontToUi(family: string) {
  // 去除文件扩展名得到 family
  const familyName = family.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/i, "");
  s.font.uiFont = familyName;
  await saveSettings();
}

async function applyFontToCode(family: string) {
  const familyName = family.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/i, "");
  s.font.codeFont = familyName;
  await saveSettings();
}

async function removeFont(index: number) {
  const path = s.font.customFonts[index];
  s.font.customFonts.splice(index, 1);
  await saveSettings();
  // 卸载已加载的字体
  const family = basename(path).replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/i, "");
  fontLoader.unload(family);
}

// ===== 开机动画模板 =====
const bootTemplates: Array<{ key: "aurora" | "minimal" | "splash" | "particles"; label: string; desc: string }> = [
  { key: "aurora", label: "极光", desc: "光球背景 + Logo 旋转环 + 进度条" },
  { key: "minimal", label: "极简", desc: "单色 Logo + 名字淡入，最快启动" },
  { key: "splash", label: "启动屏", desc: "大号 Logo 居中 + 标语展示" },
  { key: "particles", label: "粒子", desc: "粒子环绕动画 + 进度条" },
];

async function selectBootTemplate(key: "aurora" | "minimal" | "splash" | "particles") {
  s.bootAnimation.template = key;
  await saveSettings();
}

function close() {
  window.dispatchEvent(new CustomEvent("toggle-settings"));
}

// ===== 主题编辑器 =====
const colorKeys = [
  { key: "--theme-color", label: "主题色" },
  { key: "--bg-base", label: "背景基色" },
  { key: "--text-primary", label: "主文字" },
  { key: "--text-secondary", label: "次文字" },
  { key: "--text-muted", label: "弱文字" },
  { key: "--border-DEFAULT", label: "默认边框" },
];

const glassBlur = ref(20);
const glassSaturate = ref(150);
const glassOpacity = ref(28);

function getColor(key: string): string {
  const v = s.theme.customOverrides[key] ?? getComputedStyle(document.documentElement).getPropertyValue(key).trim();
  // 转换 rgba/十六进制为 color input 可接受值 (#rrggbb)
  return toHexColor(v);
}

function toHexColor(v: string): string {
  if (!v) return "#5b4fc4";
  if (v.startsWith("#")) return v.length === 7 ? v : "#5b4fc4";
  // rgba(...)
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(",").map((p) => p.trim());
    const [r, g, b] = parts;
    return (
      "#" +
      [r, g, b]
        .map((n) => Number(n).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  return "#5b4fc4";
}

function setColor(key: string, value: string) {
  s.theme.customOverrides[key] = value;
  applyEditorOverrides();
}

const previewStyle = computed(() => {
  const themeColor = s.theme.customOverrides["--theme-color"] || "var(--theme-color)";
  return {
    background: `rgba(91, 79, 196, 0.08)`,
    backdropFilter: `blur(${glassBlur.value}px) saturate(${glassSaturate.value}%)`,
    WebkitBackdropFilter: `blur(${glassBlur.value}px) saturate(${glassSaturate.value}%)`,
  } as Record<string, string>;
});

function applyEditorOverrides() {
  const overrides = { ...s.theme.customOverrides };
  // 应用玻璃参数
  const baseOpacity = glassOpacity.value / 100;
  overrides["--glass-bg"] = `rgba(255, 255, 255, ${baseOpacity})`;
  overrides["--glass-bg-strong"] = `rgba(245, 242, 255, ${baseOpacity + 0.06})`;
  themeStore.updateCustomOverrides(overrides);
}

function resetOverrides() {
  s.theme.customOverrides = {};
  glassBlur.value = 20;
  glassSaturate.value = 150;
  glassOpacity.value = 28;
  themeStore.updateCustomOverrides({});
}

function switchTheme(id: string) {
  themeStore.switchTheme(id);
}

function deleteTheme(id: string) {
  themeStore.deleteTheme(id);
}

function themePreviewStyle(t: ThemePack): Record<string, string> {
  return {
    background: `linear-gradient(135deg, ${t.light["--theme-color"]} 0%, ${t.dark["--theme-color"]} 100%)`,
    boxShadow: `0 0 0 1px ${t.light["--glass-border"]}`,
  };
}

function importTheme() {
  // 触发文件选择
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const pack = JSON.parse(text) as ThemePack;
      themeStore.importTheme(pack);
    } catch (e) {
      console.error("导入主题失败:", e);
    }
  };
  input.click();
}

// ===== 扩展管理 (本地状态) =====
const SKILL_KEY = "desktop-agent-skill-packs";
const EXT_KEY = "desktop-agent-function-extensions";

const skillPacks = ref<SkillPack[]>(loadFromStorage(SKILL_KEY, []));
const functionExtensions = ref<FunctionExtension[]>(loadFromStorage(EXT_KEY, []));

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveSkillPacks() {
  localStorage.setItem(SKILL_KEY, JSON.stringify(skillPacks.value));
}

function saveFunctionExtensions() {
  localStorage.setItem(EXT_KEY, JSON.stringify(functionExtensions.value));
}

function toggleSkillPack(id: string) {
  const sp = skillPacks.value.find((x) => x.id === id);
  if (sp) {
    sp.enabled = !sp.enabled;
    saveSkillPacks();
  }
}

function toggleExtension(id: string) {
  const fe = functionExtensions.value.find((x) => x.id === id);
  if (fe) {
    fe.enabled = !fe.enabled;
    saveFunctionExtensions();
  }
}

function importSkillPack() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const pack = JSON.parse(text) as SkillPack;
      const idx = skillPacks.value.findIndex((x) => x.id === pack.id);
      if (idx !== -1) skillPacks.value[idx] = pack;
      else skillPacks.value.push(pack);
      saveSkillPacks();
    } catch (e) {
      console.error("导入技能包失败:", e);
    }
  };
  input.click();
}

function importExtension() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const ext = JSON.parse(text) as FunctionExtension;
      const idx = functionExtensions.value.findIndex((x) => x.id === ext.id);
      if (idx !== -1) functionExtensions.value[idx] = ext;
      else functionExtensions.value.push(ext);
      saveFunctionExtensions();
    } catch (e) {
      console.error("导入扩展失败:", e);
    }
  };
  input.click();
}

// ===== 沙箱 =====
const docker = reactive({
  available: false,
  version: "",
  containers: 0,
  running: 0,
});

async function detectDocker() {
  try {
    const shell = await import("@tauri-apps/plugin-shell");
    const out = await shell.Command.create("docker-version", ["--version"]).execute();
    if (out.code === 0) {
      docker.available = true;
      docker.version = out.stdout.trim();
      // 查询容器数
      try {
        const ps = await shell.Command.create("docker-ps", ["ps", "-a", "-q"]).execute();
        docker.containers = ps.stdout.trim().split("\n").filter(Boolean).length;
        const psRunning = await shell.Command.create("docker-ps-running", ["ps", "-q"]).execute();
        docker.running = psRunning.stdout.trim().split("\n").filter(Boolean).length;
      } catch {
        /* ignore */
      }
    } else {
      docker.available = false;
    }
  } catch {
    docker.available = false;
  }
}

// ===== 键盘 =====
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  detectDocker();
  // 自动加载音色列表
  voiceStore.init();
  void voiceStore.loadVoices();
  // 加载已持久化的自定义字体
  if (s.font.customFonts.length > 0) {
    import("@/services/fontLoader").then(({ fontLoader }) => {
      fontLoader.loadAll(s.font.customFonts).catch(() => {/* 加载失败忽略 */});
    });
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
});
</script>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 1500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 18, 40, 0.45);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.settings-panel {
  width: 880px;
  max-width: 94vw;
  height: 640px;
  max-height: 90vh;
  border-radius: var(--radius-xl);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 头部 */
.sp-header {
  height: 48px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.sp-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.sp-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s var(--ease-ios);
}

.sp-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 主体 */
.sp-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.sp-nav {
  width: 180px;
  flex-shrink: 0;
  padding: 12px 8px;
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 12px;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s var(--ease-ios), color 0.15s var(--ease-ios);
  text-align: left;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--theme-color);
  color: #fff;
}

.nav-icon {
  font-size: 14px;
  width: 18px;
  text-align: center;
}

/* 内容区 */
.sp-content {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px;
}

.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 2px;
}

/* 配置块 */
.cfg-section {
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg-hover);
  color: var(--text-muted);
}

/* 表单 */
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.form-grid-2 {
  grid-template-columns: 1fr 1fr;
}

.form-grid-3 {
  grid-template-columns: repeat(3, 1fr);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field-full {
  grid-column: 1 / -1;
}

.field-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.input {
  height: 32px;
  padding: 0 10px;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s var(--ease-ios);
}

.input:focus {
  border-color: var(--theme-color);
}

.textarea {
  padding: 8px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  resize: vertical;
  font-family: var(--font-ui);
}

.textarea:focus {
  border-color: var(--theme-color);
}

.range {
  -webkit-appearance: none;
  appearance: none;
  height: 32px;
  background: transparent;
  cursor: pointer;
}

.range::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: var(--border-DEFAULT);
}

.range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--theme-color);
  margin-top: -5px;
  border: 2px solid #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.range::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: var(--border-DEFAULT);
}

.range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--theme-color);
  border: 2px solid #fff;
}

/* 限流配置 */
.rate-limit-block {
  padding-top: 10px;
  border-top: 1px dashed var(--border-subtle);
}

.block-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 500;
  margin-bottom: 4px;
}

/* 主题 */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}

.theme-card {
  position: relative;
  padding: 10px;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color 0.15s var(--ease-ios);
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
}

.theme-card:hover {
  border-color: var(--border-hover);
}

.theme-card.active {
  border-color: var(--theme-color);
  box-shadow: 0 0 0 1px var(--theme-color);
}

.theme-preview {
  width: 100%;
  height: 40px;
  border-radius: var(--radius-sm);
}

.theme-name {
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 500;
}

.theme-desc {
  font-size: 10px;
  color: var(--text-muted);
  text-align: center;
  line-height: 1.4;
}

.theme-del {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 18px;
  height: 18px;
  background: var(--bg-hover);
  border: none;
  border-radius: 50%;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.theme-del:hover {
  background: #e81123;
  color: #fff;
}

/* 编辑器 */
.editor-layout {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 16px;
}

.color-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.color-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.color-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.color-input-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
}

.color-input {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
}

.color-input::-webkit-color-swatch-wrapper {
  padding: 2px;
}

.color-input::-webkit-color-swatch {
  border: none;
  border-radius: 3px;
}

.color-value {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-code);
}

.slider-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

.preview-pane {
  border-radius: var(--radius-md);
  border: 1px solid var(--border-DEFAULT);
  padding: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
}

.preview-card {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: var(--radius-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
}

.preview-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.preview-text {
  font-size: 12px;
  color: var(--text-secondary);
}

.preview-btn {
  height: 28px;
  background: var(--theme-color);
  color: #fff;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
  align-self: flex-start;
  padding: 0 12px;
}

.preview-input {
  height: 28px;
  padding: 0 8px;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

/* 扩展 */
.ext-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
}

.ext-main {
  flex: 1;
  min-width: 0;
}

.ext-name {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
}

.ext-version {
  font-size: 10px;
  color: var(--text-muted);
  margin-left: 6px;
  font-family: var(--font-code);
}

.ext-desc {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.ext-meta {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 2px;
}

.empty-tip {
  padding: 18px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

/* 开关 */
.switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.switch-slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: var(--border-DEFAULT);
  border-radius: 20px;
  transition: background 0.2s var(--ease-ios);
}

.switch-slider::before {
  content: "";
  position: absolute;
  width: 14px;
  height: 14px;
  left: 3px;
  bottom: 3px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s var(--ease-ios);
}

.switch input:checked + .switch-slider {
  background: var(--theme-color);
}

.switch input:checked + .switch-slider::before {
  transform: translateX(16px);
}

.toggle-row {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* Docker 状态 */
.docker-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
}

.docker-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}

.docker-status.ok .docker-dot {
  background: #22c55e;
}

.docker-status.err .docker-dot {
  background: #ef4444;
}

.docker-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  background: var(--bg-input);
  border-radius: var(--radius-md);
}

.info-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
}

/* 网络模式 */
.net-modes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

/* 音色列表 */
.voice-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  max-height: 280px;
  overflow-y: auto;
  padding: 2px;
}

.voice-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color 0.15s var(--ease-ios);
}

.voice-card:hover {
  border-color: var(--border-hover);
}

.voice-card.active {
  border-color: var(--theme-color);
  box-shadow: 0 0 0 1px var(--theme-color);
}

.voice-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.voice-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.voice-meta {
  display: flex;
  gap: 6px;
  font-size: 10px;
}

.voice-gender {
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--text-muted);
}

.voice-gender.gender-male {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
}

.voice-gender.gender-female {
  background: rgba(236, 72, 153, 0.15);
  color: #ec4899;
}

.voice-lang {
  color: var(--text-muted);
}

.voice-desc {
  font-size: 10px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-btn-small {
  width: 28px;
  height: 28px;
  border: none;
  background: var(--bg-hover);
  color: var(--theme-color);
  border-radius: 50%;
  cursor: pointer;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s var(--ease-ios);
}

.preview-btn-small:hover:not(:disabled) {
  background: var(--theme-color);
  color: #fff;
  transform: scale(1.1);
}

.preview-btn-small:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 自定义字体列表 */
.custom-font-list {
  padding-top: 10px;
  border-top: 1px dashed var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.custom-font-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.cf-name {
  flex: 1;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-code);
}

.cf-apply {
  padding: 2px 8px;
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s var(--ease-ios);
}

.cf-apply:hover {
  background: var(--theme-color);
  color: #fff;
  border-color: var(--theme-color);
}

.cf-remove {
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s var(--ease-ios);
}

.cf-remove:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

/* ============ 开机动画模板卡片 ============ */
.boot-tpl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}

.boot-tpl-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 12px;
  background: var(--bg-input);
  border: 1.5px solid var(--border-DEFAULT);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-family: inherit;
  color: var(--text-primary);
  transition: all 0.18s var(--ease-ios);
}

.boot-tpl-card:hover {
  border-color: var(--border-hover);
  background: var(--bg-hover);
}

.boot-tpl-card.active {
  border-color: var(--theme-color);
  background: color-mix(in srgb, var(--theme-color) 8%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-color) 16%, transparent);
}

.boot-tpl-preview {
  position: relative;
  width: 100%;
  height: 88px;
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  overflow: hidden;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tpl-mock-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(12px);
  opacity: 0.7;
}

.boot-tpl-preview .orb-1 {
  width: 60px;
  height: 60px;
  background: var(--orb-1);
  top: -20px;
  left: -10px;
}

.boot-tpl-preview .orb-2 {
  width: 50px;
  height: 50px;
  background: var(--orb-2);
  bottom: -16px;
  right: -8px;
}

.tpl-mock-ring {
  position: absolute;
  width: 48px;
  height: 48px;
  border: 1.5px dashed var(--theme-color);
  border-radius: 50%;
  opacity: 0.6;
}

.tpl-mock-logo {
  position: relative;
  z-index: 2;
  font-size: 20px;
  font-weight: 700;
  color: var(--theme-color);
  text-shadow: 0 2px 8px var(--glow-color);
}

/* minimal 模板：去掉光球 */
.boot-tpl-preview.tpl-minimal .tpl-mock-orb { display: none; }
.boot-tpl-preview.tpl-minimal .tpl-mock-ring { display: none; }
.boot-tpl-preview.tpl-minimal .tpl-mock-logo { font-size: 22px; }

/* splash 模板：渐变背景 + 大 Logo */
.boot-tpl-preview.tpl-splash {
  background: linear-gradient(135deg, var(--bg-base), color-mix(in srgb, var(--theme-color) 26%, var(--bg-base)));
}
.boot-tpl-preview.tpl-splash .tpl-mock-orb { display: none; }
.boot-tpl-preview.tpl-splash .tpl-mock-ring { display: none; }
.boot-tpl-preview.tpl-splash .tpl-mock-logo { font-size: 26px; }

/* particles 模板：保留光球但缩小 */
.boot-tpl-preview.tpl-particles .tpl-mock-ring {
  border-style: dotted;
  animation: boot-tpl-spin 6s linear infinite;
}
@keyframes boot-tpl-spin { to { transform: rotate(360deg); } }

.boot-tpl-info {
  text-align: left;
}

.boot-tpl-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.boot-tpl-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
  line-height: 1.4;
}

.net-card {
  position: relative;
  padding: 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color 0.15s var(--ease-ios);
}

.net-card:hover {
  border-color: var(--border-hover);
}

.net-card.active {
  border-color: var(--theme-color);
  box-shadow: 0 0 0 1px var(--theme-color);
}

.net-card input {
  position: absolute;
  opacity: 0;
}

.net-card-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.net-card-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
  line-height: 1.4;
}

/* 按钮 */
.btn-mini {
  height: 26px;
  padding: 0 10px;
  background: var(--theme-color);
  color: #fff;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s var(--ease-ios);
}

.btn-mini:hover {
  background: var(--theme-accent-hover, var(--theme-color));
}
</style>
