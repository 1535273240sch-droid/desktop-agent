<template>
  <Teleport to="body">
    <transition name="fade">
      <div v-if="visible" class="editor-mask" @click.self="onClose">
        <div class="editor-modal glass-panel">
          <header class="editor-header">
            <h3>编辑记忆节点</h3>
            <button class="icon-btn" title="关闭" @click="onClose">×</button>
          </header>

          <div v-if="form" class="editor-body">
            <div class="form-row">
              <label>类型</label>
              <select v-model="form.type" class="field">
                <option value="user-info">用户信息</option>
                <option value="knowledge">知识点</option>
                <option value="task-record">任务记录</option>
              </select>
            </div>

            <div class="form-row">
              <label>标题</label>
              <input v-model="form.title" class="field" placeholder="节点标题" />
            </div>

            <div class="form-row">
              <label>摘要</label>
              <input v-model="form.summary" class="field" placeholder="一句话摘要" />
            </div>

            <div class="form-row">
              <label>详情</label>
              <textarea v-model="form.details" class="field textarea" rows="4" placeholder="详细内容" />
            </div>

            <div class="form-row">
              <label>标签</label>
              <div class="tags-area">
                <span v-for="(tag, i) in form.tags" :key="i" class="tag-chip">
                  {{ tag }}
                  <button class="tag-remove" @click="removeTag(i)">×</button>
                </span>
                <input
                  v-model="newTag"
                  class="tag-input"
                  placeholder="添加标签后回车"
                  @keydown.enter.prevent="addTag"
                />
              </div>
            </div>

            <div class="form-row">
              <label>关联</label>
              <div class="links-area">
                <div v-if="currentLinks.length === 0" class="empty-tip">暂无关联节点</div>
                <div v-for="link in currentLinks" :key="link.targetId" class="link-row">
                  <span class="link-dot" :style="{ background: typeColor(link.type) }" />
                  <span class="link-title">{{ link.title }}</span>
                  <span class="link-type">{{ typeLabel(link.type) }}</span>
                  <button class="link-remove" @click="onRemoveLink(link.targetId)">移除</button>
                </div>
                <div class="link-add">
                  <select v-model="newLinkTarget" class="field small">
                    <option value="">选择节点建立关联…</option>
                    <option
                      v-for="n in candidateNodes"
                      :key="n.id"
                      :value="n.id"
                    >
                      {{ n.title }}（{{ typeLabel(n.type) }}）
                    </option>
                  </select>
                  <button
                    class="btn small"
                    :disabled="!newLinkTarget"
                    @click="onAddLink"
                  >
                    添加
                  </button>
                </div>
              </div>
            </div>
          </div>

          <footer class="editor-footer">
            <button class="btn danger" @click="onDelete">删除节点</button>
            <div class="footer-right">
              <button class="btn ghost" @click="onClose">取消</button>
              <button class="btn primary" @click="onSave">保存</button>
            </div>
          </footer>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from "vue";
import type { MemoryNode, MemoryNodeType, MemoryLink } from "@/types";
import { MEMORY_TYPE_LABEL } from "./MemoryGraph";

const props = defineProps<{
  visible: boolean;
  node: MemoryNode | null;
  allNodes: MemoryNode[];
  links: MemoryLink[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "save", node: MemoryNode): void;
  (e: "delete", id: string): void;
  (e: "addLink", targetId: string): void;
  (e: "removeLink", targetId: string): void;
}>();

interface FormState {
  id: string;
  type: MemoryNodeType;
  title: string;
  summary: string;
  details: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

const form = ref<FormState | null>(null);
const newTag = ref("");
const newLinkTarget = ref("");

function typeColor(t: MemoryNodeType): string {
  const map: Record<MemoryNodeType, string> = {
    "user-info": "var(--memory-user-info)",
    knowledge: "var(--memory-knowledge)",
    "task-record": "var(--memory-task-record)",
  };
  return map[t];
}

function typeLabel(t: MemoryNodeType): string {
  return MEMORY_TYPE_LABEL[t];
}

watch(
  () => [props.visible, props.node],
  () => {
    if (props.visible && props.node) {
      form.value = {
        id: props.node.id,
        type: props.node.type,
        title: props.node.title,
        summary: props.node.summary,
        details: props.node.details,
        tags: [...props.node.tags],
        createdAt: props.node.createdAt,
        updatedAt: props.node.updatedAt,
      };
      newTag.value = "";
      newLinkTarget.value = "";
    } else {
      form.value = null;
    }
  },
  { immediate: true }
);

// 当前节点的关联列表（带对端节点信息）
const currentLinks = computed(() => {
  if (!props.node) return [];
  const id = props.node.id;
  const out: { targetId: string; title: string; type: MemoryNodeType }[] = [];
  for (const l of props.links) {
    if (l.source === id) {
      const other = props.allNodes.find((n) => n.id === l.target);
      if (other) out.push({ targetId: other.id, title: other.title, type: other.type });
    } else if (l.target === id) {
      const other = props.allNodes.find((n) => n.id === l.source);
      if (other) out.push({ targetId: other.id, title: other.title, type: other.type });
    }
  }
  return out;
});

// 可建立关联的节点：除自身、且当前未关联
const candidateNodes = computed(() => {
  if (!props.node) return [];
  const linkedIds = new Set(currentLinks.value.map((l) => l.targetId));
  return props.allNodes.filter((n) => n.id !== props.node!.id && !linkedIds.has(n.id));
});

function addTag() {
  const t = newTag.value.trim();
  if (!t || !form.value) return;
  if (!form.value.tags.includes(t)) form.value.tags.push(t);
  newTag.value = "";
}

function removeTag(i: number) {
  form.value?.tags.splice(i, 1);
}

function onAddLink() {
  if (!newLinkTarget.value) return;
  emit("addLink", newLinkTarget.value);
  newLinkTarget.value = "";
}

function onRemoveLink(targetId: string) {
  emit("removeLink", targetId);
}

function onSave() {
  if (!form.value) return;
  const now = Date.now();
  emit("save", {
    id: form.value.id,
    type: form.value.type,
    title: form.value.title.trim() || "未命名",
    summary: form.value.summary.trim(),
    details: form.value.details.trim(),
    tags: [...form.value.tags],
    createdAt: form.value.createdAt,
    updatedAt: now,
  } as MemoryNode);
}

function onDelete() {
  if (form.value && confirm("确认删除该记忆节点？相关关联也会被移除。")) {
    emit("delete", form.value.id);
  }
}

function onClose() {
  emit("close");
}
</script>

<style scoped>
.editor-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(20, 18, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.editor-modal {
  width: 460px;
  max-width: 92vw;
  max-height: 88vh;
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text-primary);
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-subtle);
}
.editor-header h3 {
  font-size: 15px;
  font-weight: 600;
}

.editor-body {
  padding: 16px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.form-row > label {
  font-size: 12px;
  color: var(--text-muted);
}

.field {
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.2s var(--ease-ios);
  font-family: inherit;
}
.field:focus {
  border-color: var(--theme-color);
}
.field.textarea {
  resize: vertical;
  min-height: 64px;
}
.field.small {
  padding: 6px 8px;
  font-size: 12px;
  flex: 1;
}

.tags-area {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: color-mix(in srgb, var(--theme-color) 18%, transparent);
  color: var(--text-primary);
  border-radius: 10px;
  padding: 2px 8px;
  font-size: 11px;
}
.tag-remove {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1;
  padding: 0;
}
.tag-input {
  flex: 1;
  min-width: 100px;
  background: transparent;
  border: none;
  outline: none;
  font-size: 12px;
  color: var(--text-primary);
  font-family: inherit;
}

.links-area {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.empty-tip {
  font-size: 12px;
  color: var(--text-muted);
  padding: 6px 0;
}
.link-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--bg-input);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.link-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.link-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link-type {
  color: var(--text-muted);
  font-size: 11px;
}
.link-remove {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 11px;
  padding: 2px 4px;
}
.link-remove:hover {
  color: #ef4444;
}
.link-add {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-top: 1px solid var(--border-subtle);
}
.footer-right {
  display: flex;
  gap: 8px;
}

.icon-btn {
  background: transparent;
  border: none;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  color: var(--text-muted);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}
.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn {
  border: 1px solid var(--border-DEFAULT);
  background: var(--bg-elevated);
  color: var(--text-primary);
  padding: 7px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: background 0.2s var(--ease-ios), border-color 0.2s var(--ease-ios);
}
.btn:hover:not(:disabled) {
  background: var(--bg-hover);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn.small {
  padding: 5px 10px;
  font-size: 11px;
}
.btn.primary {
  background: var(--theme-color);
  color: #fff;
  border-color: var(--theme-color);
}
.btn.primary:hover:not(:disabled) {
  background: var(--theme-accent-hover, var(--theme-color));
}
.btn.ghost {
  background: transparent;
}
.btn.danger {
  background: transparent;
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.4);
}
.btn.danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s var(--ease-ios);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
