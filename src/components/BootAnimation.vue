<template>
  <div
    class="boot-animation"
    :class="[`tpl-${template}`, { 'is-leaving': isLeaving }]"
    @click="skip"
  >
    <!-- ============ 模板：aurora（默认，极光光球 + Logo 旋转环 + 进度条） ============ -->
    <template v-if="template === 'aurora'">
      <div class="boot-orbs">
        <div class="boot-orb orb-1" />
        <div class="boot-orb orb-2" />
        <div class="boot-orb orb-3" />
      </div>
      <div class="boot-content">
        <div class="boot-logo">
          <InlineLogoSvg :color="themeColor" />
          <div class="boot-progress">
            <div class="boot-progress-bar" />
          </div>
        </div>
        <div class="boot-name-wrap">
          <h1 class="boot-name">{{ agentName }}</h1>
          <p class="boot-tagline">Desktop Agent · 正在唤醒</p>
        </div>
      </div>
    </template>

    <!-- ============ 模板：minimal（单色极简，仅 Logo + 名字淡入） ============ -->
    <template v-else-if="template === 'minimal'">
      <div class="boot-content minimal-content">
        <div class="boot-logo-minimal">
          <InlineLogoSvg :color="themeColor" :simple="true" />
        </div>
        <div class="boot-name-wrap minimal-name">
          <h1 class="boot-name">{{ agentName }}</h1>
        </div>
      </div>
    </template>

    <!-- ============ 模板：splash（大号 Logo + 标语居中） ============ -->
    <template v-else-if="template === 'splash'">
      <div class="boot-content splash-content">
        <div class="boot-logo-splash">
          <InlineLogoSvg :color="themeColor" />
        </div>
        <div class="boot-name-wrap splash-name">
          <h1 class="boot-name">{{ agentName }}</h1>
          <p class="boot-tagline">Desktop Agent</p>
        </div>
      </div>
    </template>

    <!-- ============ 模板：particles（粒子环绕） ============ -->
    <template v-else-if="template === 'particles'">
      <div class="particles-bg" ref="particlesRef" />
      <div class="boot-content particles-content">
        <div class="boot-logo-particles">
          <InlineLogoSvg :color="themeColor" />
        </div>
        <div class="boot-name-wrap">
          <h1 class="boot-name">{{ agentName }}</h1>
          <p class="boot-tagline">Desktop Agent · 正在唤醒</p>
        </div>
        <div class="boot-progress">
          <div class="boot-progress-bar" />
        </div>
      </div>
    </template>

    <!-- 跳过提示 -->
    <div v-if="showSkipHint" class="boot-skip-hint">点击任意位置或按 ESC 跳过</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, h, defineComponent } from "vue";
import { useSettingsStore } from "@/stores/settings";
import type { BootAnimationTemplate } from "@/types";

const settings = useSettingsStore();

// ============ 模板配置 ============
const template = computed<BootAnimationTemplate>(
  () => settings.settings.bootAnimation?.template ?? "aurora"
);
const durationMs = computed(() => settings.settings.bootAnimation?.durationMs ?? 1800);
const showSkipHint = computed(() => settings.settings.bootAnimation?.showSkipHint ?? true);
const customLogoUrl = computed(() => settings.settings.bootAnimation?.customLogoUrl ?? "");

const agentName = computed(() => settings.settings.agentName || "小助");

// 跟随主题色: 读取当前 CSS 变量 --theme-color
const themeColor = ref("#5B4FC4");
function syncThemeColor() {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--theme-color")
    .trim();
  if (v) themeColor.value = v;
}

const isLeaving = ref(false);
let leaveTimer: number | null = null;
let completeTimer: number | null = null;

const emit = defineEmits<{
  (e: "complete"): void;
  (e: "skip"): void;
}>();

function finish(type: "complete" | "skip") {
  if (isLeaving.value) return;
  isLeaving.value = true;
  leaveTimer = window.setTimeout(() => {
    if (type === "complete") emit("complete");
    else emit("skip");
  }, 380);
}

function skip() {
  finish("skip");
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    skip();
  }
}

// ============ particles 模板：动态粒子 ============
const particlesRef = ref<HTMLDivElement | null>(null);
let particleRaf = 0;

function spawnParticles() {
  const host = particlesRef.value;
  if (!host) return;
  // 创建 60 个粒子
  for (let i = 0; i < 60; i++) {
    const p = document.createElement("span");
    p.className = "particle";
    const angle = (i / 60) * Math.PI * 2;
    const radius = 120 + Math.random() * 80;
    const dx = Math.cos(angle) * radius;
    const dy = Math.sin(angle) * radius;
    p.style.setProperty("--dx", `${dx}px`);
    p.style.setProperty("--dy", `${dy}px`);
    p.style.setProperty("--delay", `${(i / 60) * -1.6}s`);
    p.style.setProperty("--size", `${3 + Math.random() * 4}px`);
    p.style.background = i % 3 === 0 ? themeColor.value : "var(--orb-2)";
    host.appendChild(p);
  }
}

onMounted(() => {
  syncThemeColor();
  window.addEventListener("keydown", onKey);

  // particles 模板初始化
  if (template.value === "particles") {
    requestAnimationFrame(() => {
      spawnParticles();
    });
  }

  // 完成回调
  const duration = durationMs.value > 0 ? durationMs.value : 1800;
  completeTimer = window.setTimeout(() => {
    finish("complete");
  }, duration);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  if (leaveTimer) window.clearTimeout(leaveTimer);
  if (completeTimer) window.clearTimeout(completeTimer);
  if (particleRaf) cancelAnimationFrame(particleRaf);
});

// ============ 内联 SVG Logo 组件 ============
const InlineLogoSvg = defineComponent({
  name: "InlineLogoSvg",
  props: {
    color: { type: String, default: "#5B4FC4" },
    simple: { type: Boolean, default: false },
  },
  setup(props) {
    return () =>
      h(
        "svg",
        {
          class: "logo-svg",
          viewBox: "0 0 120 120",
          xmlns: "http://www.w3.org/2000/svg",
        },
        [
          h("defs", {}, [
            h(
              "radialGradient",
              { id: "bootGlow", cx: "50%", cy: "50%", r: "50%" },
              [
                h("stop", { offset: "0%", "stop-color": props.color, "stop-opacity": "0.55" }),
                h("stop", { offset: "100%", "stop-color": props.color, "stop-opacity": "0" }),
              ]
            ),
            h(
              "linearGradient",
              { id: "bootRing", x1: "0%", y1: "0%", x2: "100%", y2: "100%" },
              [
                h("stop", { offset: "0%", "stop-color": props.color, "stop-opacity": "0.95" }),
                h("stop", { offset: "100%", "stop-color": props.color, "stop-opacity": "0.35" }),
              ]
            ),
          ]),
          // 外发光
          h("circle", {
            class: "logo-glow",
            cx: "60", cy: "60", r: "56", fill: "url(#bootGlow)",
          }),
          // 旋转外环（simple 模式不渲染）
          !props.simple
            ? h("circle", {
                class: "logo-ring logo-ring-1",
                cx: "60", cy: "60", r: "48", fill: "none",
                stroke: "url(#bootRing)", "stroke-width": "2",
                "stroke-linecap": "round", "stroke-dasharray": "80 220",
              })
            : null,
          !props.simple
            ? h("circle", {
                class: "logo-ring logo-ring-2",
                cx: "60", cy: "60", r: "40", fill: "none",
                stroke: props.color, "stroke-width": "1.5",
                "stroke-linecap": "round", "stroke-opacity": "0.55",
                "stroke-dasharray": "40 200",
              })
            : null,
          // Agent 主体
          customLogoUrl.value
            ? h("image", {
                href: customLogoUrl.value,
                x: "30", y: "30", width: "60", height: "60",
                "clip-path": "inset(0 round 14)",
              })
            : h("g", { class: "logo-body" }, [
                h("rect", {
                  x: "36", y: "36", width: "48", height: "48",
                  rx: "14", ry: "14",
                  fill: props.color, "fill-opacity": "0.18",
                  stroke: props.color, "stroke-width": "1.6",
                }),
                h("circle", { class: "logo-eye logo-eye-left", cx: "51", cy: "56", r: "2.6", fill: props.color }),
                h("circle", { class: "logo-eye logo-eye-right", cx: "69", cy: "56", r: "2.6", fill: props.color }),
                h("path", {
                  d: "M50 66 Q60 72 70 66", fill: "none",
                  stroke: props.color, "stroke-width": "1.8", "stroke-linecap": "round",
                }),
                h("line", {
                  x1: "60", y1: "36", x2: "60", y2: "28",
                  stroke: props.color, "stroke-width": "1.6", "stroke-linecap": "round",
                }),
                h("circle", { cx: "60", cy: "26", r: "2.4", fill: props.color }),
              ]),
        ]
      );
  },
});
</script>

<style scoped>
.boot-animation {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-base);
  cursor: pointer;
  user-select: none;
  overflow: hidden;
  transition: opacity 0.38s var(--ease-ios);
}

.boot-animation.is-leaving {
  opacity: 0;
}

/* ============ 模板：aurora（默认） ============ */
.boot-orbs {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.boot-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(70px);
  opacity: 0.85;
  animation: boot-orb-float 6s ease-in-out infinite;
}

.orb-1 { width: 360px; height: 360px; background: var(--orb-1); top: -120px; left: -80px; }
.orb-2 { width: 280px; height: 280px; background: var(--orb-2); bottom: -80px; right: -60px; animation-delay: -2s; }
.orb-3 { width: 220px; height: 220px; background: var(--orb-3); top: 40%; left: 55%; animation-delay: -4s; }

@keyframes boot-orb-float {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(20px, -20px) scale(1.08); }
}

.boot-content {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28px;
}

.boot-logo {
  position: relative;
  width: 160px;
  height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: boot-pop 0.7s var(--ease-out-expo) both;
}

.logo-svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}

.logo-glow {
  transform-origin: center;
  animation: boot-pulse 1.6s ease-in-out infinite;
}

.logo-ring {
  transform-origin: 60px 60px;
}
.logo-ring-1 { animation: boot-spin 1.4s linear infinite; }
.logo-ring-2 { animation: boot-spin-reverse 1.8s linear infinite; }

.logo-body {
  transform-origin: 60px 60px;
  animation: boot-body-in 0.9s var(--ease-out-expo) 0.2s both;
}

.logo-eye {
  animation: boot-blink 2.4s ease-in-out infinite;
  transform-origin: center;
}

@keyframes boot-pop {
  0% { transform: scale(0.6); opacity: 0; }
  60% { transform: scale(1.06); opacity: 1; }
  100% { transform: scale(1); }
}
@keyframes boot-pulse {
  0%, 100% { transform: scale(1); opacity: 0.8; }
  50% { transform: scale(1.12); opacity: 1; }
}
@keyframes boot-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes boot-spin-reverse { from { transform: rotate(360deg); } to { transform: rotate(0deg); } }
@keyframes boot-body-in {
  0% { transform: translateY(8px) scale(0.9); opacity: 0; }
  100% { transform: translateY(0) scale(1); opacity: 1; }
}
@keyframes boot-blink {
  0%, 92%, 100% { transform: scaleY(1); }
  96% { transform: scaleY(0.1); }
}

.boot-progress {
  position: absolute;
  bottom: -10px;
  left: 50%;
  transform: translateX(-50%);
  width: 110px;
  height: 3px;
  border-radius: 2px;
  background: var(--border-subtle);
  overflow: hidden;
}

.boot-progress-bar {
  height: 100%;
  width: 0%;
  background: var(--theme-color);
  border-radius: 2px;
  animation: boot-progress 1.6s var(--ease-ios) 0.2s forwards;
}

@keyframes boot-progress {
  0% { width: 0%; }
  100% { width: 100%; }
}

.boot-name-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  animation: boot-name-lifecycle 1.8s var(--ease-ios) 0.3s both;
}

.boot-name {
  font-size: 26px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 1.5px;
  margin: 0;
  text-shadow: 0 2px 12px var(--glow-color);
}

.boot-tagline {
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 0.5px;
  margin: 0;
}

@keyframes boot-name-lifecycle {
  0% { opacity: 0; transform: translateY(8px); }
  25% { opacity: 1; transform: translateY(0); }
  70% { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(-4px); }
}

.boot-skip-hint {
  position: absolute;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.7;
  letter-spacing: 0.3px;
  animation: boot-hint-fade 1.6s ease-in-out infinite;
}

@keyframes boot-hint-fade {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.85; }
}

/* ============ 模板：minimal ============ */
.tpl-minimal .boot-content {
  gap: 18px;
}
.minimal-content {
  animation: boot-fade-in 0.6s var(--ease-ios) both;
}
.boot-logo-minimal {
  width: 96px;
  height: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.boot-logo-minimal .logo-svg {
  width: 100%;
  height: 100%;
}
.boot-logo-minimal .logo-body {
  animation: none;
}
.minimal-name {
  animation: none;
  opacity: 0;
  animation: boot-fade-in 0.8s var(--ease-ios) 0.2s both;
}
@keyframes boot-fade-in {
  0% { opacity: 0; transform: translateY(4px); }
  100% { opacity: 1; transform: translateY(0); }
}

/* ============ 模板：splash ============ */
.tpl-splash {
  background: linear-gradient(135deg, var(--bg-base), color-mix(in srgb, var(--theme-color) 22%, var(--bg-base)));
}
.splash-content {
  gap: 36px;
}
.boot-logo-splash {
  width: 200px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: boot-pop 1.2s var(--ease-out-expo) both;
}
.boot-logo-splash .logo-svg {
  width: 100%;
  height: 100%;
}
.splash-name {
  gap: 10px;
  animation: boot-fade-in 0.8s var(--ease-ios) 0.4s both;
}
.splash-name .boot-name {
  font-size: 36px;
  letter-spacing: 2px;
}
.splash-name .boot-tagline {
  font-size: 14px;
}

/* ============ 模板：particles ============ */
.particles-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.particle {
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--size);
  height: var(--size);
  border-radius: 50%;
  opacity: 0;
  animation: particle-out 1.6s var(--ease-out-expo) var(--delay, 0s) infinite;
}
@keyframes particle-out {
  0% {
    transform: translate(-50%, -50%) translate(0, 0) scale(0.4);
    opacity: 0;
  }
  20% { opacity: 0.9; }
  100% {
    transform: translate(-50%, -50%) translate(var(--dx), var(--dy)) scale(1);
    opacity: 0;
  }
}
.particles-content {
  gap: 24px;
}
.boot-logo-particles {
  width: 160px;
  height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: boot-pulse 2.4s ease-in-out infinite;
}
.boot-logo-particles .logo-svg {
  width: 100%;
  height: 100%;
}
.particles-content .boot-progress {
  position: static;
  transform: none;
  margin-top: 12px;
}
</style>
