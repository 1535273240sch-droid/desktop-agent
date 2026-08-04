<template>
  <div
    class="waveform"
    :class="[`state-${state}`, { 'audio-driven': audioDriven }]"
    :style="cssVars"
  >
    <span
      v-for="(bar, i) in bars"
      :key="i"
      ref="barEls"
      class="bar"
      :style="{
        animationDelay: `${bar.delay}s`,
        animationDuration: `${bar.duration}s`,
      }"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, shallowRef } from "vue";

type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "recording";

const props = withDefaults(
  defineProps<{
    audioStream?: MediaStream | null;
    state?: VoiceState;
    barCount?: number;
  }>(),
  {
    audioStream: null,
    state: "idle",
    barCount: 32,
  }
);

const BAR_COUNT = computed(() => props.barCount);

// 每条波形的延迟与基础时长，构成左右流动的波浪
const bars = computed(() => {
  const n = BAR_COUNT.value;
  return Array.from({ length: n }, (_, i) => {
    // 中间高、两端低，让整体呈山峰起伏
    const mid = (n - 1) / 2;
    const positional = 1 - Math.abs(i - mid) / mid; // 0..1
    // 延迟随索引递增，形成左右波浪
    const delay = (i / n) * 0.9;
    const duration = 0.9 + positional * 0.4;
    return { delay, duration };
  });
});

// 不同状态下的 CSS 变量：振幅与时长
const cssVars = computed(() => {
  switch (props.state) {
    case "listening":
      return {
        "--wave-min": "0.18",
        "--wave-max": "0.55",
        "--wave-dur": "1.3s",
        "--bar-color": "var(--orb-2, #38bdf8)",
        "--bar-opacity": "0.9",
      };
    case "recording":
      // 录音中：与 listening 相近，但色调偏暖以区分
      return {
        "--wave-min": "0.2",
        "--wave-max": "0.6",
        "--wave-dur": "1.2s",
        "--bar-color": "var(--orb-1, #f472b6)",
        "--bar-opacity": "0.92",
      };
    case "thinking":
      // 静止：振幅极小
      return {
        "--wave-min": "0.1",
        "--wave-max": "0.14",
        "--wave-dur": "2.4s",
        "--bar-color": "var(--text-muted, #8B82C9)",
        "--bar-opacity": "0.55",
      };
    case "speaking":
      // 高频高幅
      return {
        "--wave-min": "0.28",
        "--wave-max": "1",
        "--wave-dur": "0.55s",
        "--bar-color": "var(--theme-color, #5B4FC4)",
        "--bar-opacity": "1",
      };
    default:
      return {
        "--wave-min": "0.08",
        "--wave-max": "0.12",
        "--wave-dur": "2s",
        "--bar-color": "var(--text-muted, #8B82C9)",
        "--bar-opacity": "0.4",
      };
  }
});

// ========== Web Audio API 实时音量驱动 ==========
const barEls = ref<(HTMLSpanElement | null)[]>([]);
const audioDriven = ref(false);

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let rafId: number | null = null;
let freqData: Uint8Array<ArrayBuffer> | null = null;
// shallowRef 用来存放不响应的清理函数
const stopSignal = shallowRef(false);

async function setupAnalyser(stream: MediaStream) {
  teardownAnalyser();
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
    source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = BAR_COUNT.value * 2; // 64 → 32 频率bins
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    audioDriven.value = true;
    stopSignal.value = false;
    loop();
  } catch (e) {
    // 降级到纯 CSS 动画
    audioDriven.value = false;
  }
}

function loop() {
  if (stopSignal.value || !analyser || !freqData) return;
  analyser.getByteFrequencyData(freqData);
  const n = Math.min(BAR_COUNT.value, freqData.length);
  const els = barEls.value;
  for (let i = 0; i < n; i++) {
    const el = els[i];
    if (!el) continue;
    // 归一化到 0.08..1，叠加轻微位置权重形成对称峰
    const v = freqData[i] / 255;
    const scale = 0.08 + v * 0.92;
    el.style.transform = `scaleY(${scale.toFixed(3)})`;
  }
  rafId = requestAnimationFrame(loop);
}

function teardownAnalyser() {
  stopSignal.value = true;
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  try {
    source?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    analyser?.disconnect();
  } catch {
    /* ignore */
  }
  source = null;
  analyser = null;
  freqData = null;
  audioDriven.value = false;
  // 清除内联 transform，恢复 CSS 动画
  for (const el of barEls.value) {
    if (el) el.style.transform = "";
  }
}

watch(
  () => props.audioStream,
  (stream) => {
    if (stream && stream.getAudioTracks().length > 0) {
      void setupAnalyser(stream);
    } else {
      teardownAnalyser();
    }
  },
  { immediate: true }
);

watch(
  () => props.state,
  (s) => {
    // 思考态：暂停音频驱动，交由静态 CSS
    if (s === "thinking" && audioDriven.value) {
      stopSignal.value = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = null;
    } else if (audioDriven.value && props.audioStream) {
      stopSignal.value = false;
      loop();
    }
  }
);

onBeforeUnmount(() => {
  teardownAnalyser();
  if (audioCtx) {
    audioCtx.close().catch(() => undefined);
    audioCtx = null;
  }
});
</script>

<style scoped>
.waveform {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 64px;
  width: 100%;
  --wave-min: 0.1;
  --wave-max: 0.4;
  --wave-dur: 1.2s;
  --bar-color: var(--theme-color);
  --bar-opacity: 0.8;
}

.bar {
  width: 4px;
  height: 100%;
  border-radius: 2px;
  background: var(--bar-color);
  opacity: var(--bar-opacity);
  transform-origin: center center;
  transform: scaleY(var(--wave-min));
  animation-name: wave-bar;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
  will-change: transform;
  /* GPU 加速，保证 60fps */
  backface-visibility: hidden;
  transition: background 0.4s var(--ease-ios), opacity 0.4s var(--ease-ios);
}

@keyframes wave-bar {
  0%,
  100% {
    transform: scaleY(var(--wave-min));
  }
  50% {
    transform: scaleY(var(--wave-max));
  }
}

/* 思考态：几乎静止，仅微弱呼吸 */
.state-thinking .bar {
  animation-duration: var(--wave-dur) !important;
}

/* 音频驱动时关闭 CSS 动画，由 JS 接管 transform */
.waveform.audio-driven .bar {
  animation: none;
}
</style>
