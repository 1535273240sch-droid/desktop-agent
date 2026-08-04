<template>
  <Teleport to="body" v-if="overlay">
    <transition name="splash-fade">
      <div v-if="visible" class="splash-mask" :style="themeStyle">
        <div class="splash-card glass-panel">
          <component :is="loaderComp" />
          <div v-if="title" class="splash-title">{{ title }}</div>
          <div v-if="message" class="splash-message">{{ message }}</div>
          <div v-if="showProgress" class="progress-track">
            <div class="progress-fill" :style="{ width: progressPct + '%' }" />
          </div>
          <div v-if="showProgress" class="progress-text">{{ progressPct }}%</div>
          <button v-if="cancellable" class="splash-cancel" @click="$emit('cancel')">取消</button>
        </div>
      </div>
    </transition>
  </Teleport>
  <div v-else class="splash-inline" :style="themeStyle">
    <component :is="loaderComp" />
    <div v-if="title" class="splash-title">{{ title }}</div>
    <div v-if="message" class="splash-message">{{ message }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, type Component } from "vue";

type Variant = "ring" | "dots" | "pulse";

const props = withDefaults(
  defineProps<{
    visible?: boolean;
    title?: string;
    message?: string;
    /** 0-100；不传则不确定进度 */
    progress?: number | null;
    variant?: Variant;
    /** 是否作为全屏遮罩，否则内联 */
    overlay?: boolean;
    cancellable?: boolean;
    /** 注入主题色变量（可选） */
    themeVars?: Record<string, string>;
  }>(),
  {
    visible: true,
    title: "",
    message: "",
    progress: null,
    variant: "ring",
    overlay: true,
    cancellable: false,
    themeVars: () => ({}),
  }
);

defineEmits<{ (e: "cancel"): void }>();

const themeStyle = computed(() => ({ ...props.themeVars }));

const showProgress = computed(() => typeof props.progress === "number");
const progressPct = computed(() => {
  if (typeof props.progress !== "number") return 0;
  return Math.max(0, Math.min(100, Math.round(props.progress)));
});

// 三种主题色加载动画
const RingLoader: Component = defineComponent({
  name: "RingLoader",
  render() {
    return h("div", { class: "loader-ring" }, [
      h("div", { class: "ring ring-1" }),
      h("div", { class: "ring ring-2" }),
      h("div", { class: "ring ring-3" }),
    ]);
  },
});

const DotsLoader: Component = defineComponent({
  name: "DotsLoader",
  render() {
    return h("div", { class: "loader-dots" }, [
      h("span", { class: "dot dot-1" }),
      h("span", { class: "dot dot-2" }),
      h("span", { class: "dot dot-3" }),
    ]);
  },
});

const PulseLoader: Component = defineComponent({
  name: "PulseLoader",
  render() {
    return h("div", { class: "loader-pulse" }, [
      h("div", { class: "pulse-core" }),
      h("div", { class: "pulse-wave" }),
    ]);
  },
});

const loaderComp = computed<Component>(() => {
  switch (props.variant) {
    case "dots":
      return DotsLoader;
    case "pulse":
      return PulseLoader;
    default:
      return RingLoader;
  }
});
</script>

<style scoped>
.splash-mask {
  position: fixed;
  inset: 0;
  z-index: 180;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 18, 40, 0.45);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.splash-card {
  min-width: 240px;
  max-width: 360px;
  padding: 28px 32px;
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
  color: var(--text-primary);
}

.splash-inline {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px;
  color: var(--text-primary);
}

.splash-title {
  font-size: 15px;
  font-weight: 600;
}
.splash-message {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
  max-width: 280px;
}

.progress-track {
  width: 220px;
  height: 6px;
  background: var(--bg-input);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 4px;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(
    90deg,
    var(--theme-color),
    color-mix(in srgb, var(--theme-color) 60%, white)
  );
  border-radius: 999px;
  transition: width 0.3s var(--ease-ios);
}
.progress-text {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.splash-cancel {
  margin-top: 6px;
  background: transparent;
  border: 1px solid var(--border-DEFAULT);
  color: var(--text-secondary);
  border-radius: 999px;
  padding: 5px 16px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.2s var(--ease-ios);
}
.splash-cancel:hover {
  background: var(--bg-hover);
}

/* ===== 环形加载 ===== */
.loader-ring {
  position: relative;
  width: 56px;
  height: 56px;
}
.ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 3px solid transparent;
}
.ring-1 {
  border-top-color: var(--theme-color);
  border-right-color: color-mix(in srgb, var(--theme-color) 50%, transparent);
  animation: ring-spin 1s linear infinite;
}
.ring-2 {
  inset: 8px;
  border-bottom-color: color-mix(in srgb, var(--theme-color) 70%, transparent);
  animation: ring-spin 1.4s linear infinite reverse;
}
.ring-3 {
  inset: 16px;
  border-top-color: color-mix(in srgb, var(--theme-color) 40%, transparent);
  animation: ring-spin 0.8s linear infinite;
}
@keyframes ring-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ===== 点点加载 ===== */
.loader-dots {
  display: flex;
  gap: 8px;
  height: 56px;
  align-items: center;
}
.loader-dots .dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--theme-color);
  animation: dot-bounce 1.2s var(--ease-ios) infinite;
}
.dot-2 {
  animation-delay: 0.15s;
}
.dot-3 {
  animation-delay: 0.3s;
}
@keyframes dot-bounce {
  0%, 80%, 100% {
    transform: scale(0.6);
    opacity: 0.6;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}

/* ===== 脉冲加载 ===== */
.loader-pulse {
  position: relative;
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pulse-core {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--theme-color);
  animation: pulse-core 1.6s var(--ease-out-expo) infinite;
}
.pulse-wave {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid var(--theme-color);
  animation: pulse-wave 1.6s var(--ease-out-expo) infinite;
}
@keyframes pulse-core {
  0%, 100% {
    transform: scale(1);
  }
  50% {
    transform: scale(0.7);
  }
}
@keyframes pulse-wave {
  0% {
    transform: scale(0.3);
    opacity: 0.9;
  }
  100% {
    transform: scale(1);
    opacity: 0;
  }
}

/* 过渡 */
.splash-fade-enter-active,
.splash-fade-leave-active {
  transition: opacity 0.25s var(--ease-ios);
}
.splash-fade-enter-from,
.splash-fade-leave-to {
  opacity: 0;
}
</style>
