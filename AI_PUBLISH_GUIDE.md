# AI 自动发布指南

## 1. 设置 GitHub Token（一次性）

### 步骤：
1. 打开 https://github.com/settings/tokens/new
2. Note 填 `ai-auto-publish`
3. Expiration 选 `No expiration`
4. 只勾选 `repo` 权限
5. 点击 Generate token，**复制保存**

## 2. 设置 GitHub 仓库 Secret

1. 打开仓库 → **Settings → Secrets and variables → Actions**
2. 点击 **New repository secret**
3. 添加以下 Secret：

| Name | Value | 说明 |
|---|---|---|
| `AI_PUBLISH_TOKEN` | 刚才生成的 Token | 用于 AI 推送代码 |
| `TAURI_SIGNING_PRIVATE_KEY` | 你的签名私钥 | 用于签名安装包 |

## 3. AI 发布标准流程

任何 AI 代理只需要遵循以下命令模板：

### 修改功能并发布新版本：

```bash
# 1. 修改代码（AI 自动完成）

# 2. 更新版本号
cd src-tauri && sed -i 's/"version": "0.1.0"/"version": "0.1.1"/' tauri.conf.json

# 3. 提交并推送
git add -A
git commit -m "feat: 修改描述"
git push origin main

# 4. 触发新版本发布
git tag v0.1.1
git push origin v0.1.1
```

### 只发布（不改代码）：

```bash
# 直接打新标签触发构建
VERSION=0.1.1
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
git add -A && git commit -m "chore: bump version to v$VERSION"
git push origin main
git tag v$VERSION
git push origin v$VERSION
```

## 4. 给 AI 的 Prompt 模板

把下面这段作为你给任何 AI 的指令：

```
你是我的代码助手。当我要求你修改功能并发布时，请按以下流程操作：

1. 修改代码
2. 更新 src-tauri/tauri.conf.json 中的 version 字段（补丁号 +1）
3. 执行以下命令发布：
   git add -A
   git commit -m "描述修改内容"
   git push origin main
   git tag v{新版本号}
   git push origin v{新版本号}

注意：
- 版本号格式：v主.次.补丁（如 v0.1.1, v0.2.0, v1.0.0）
- 每次发布前必须确认修改内容
- 如果需要 GitHub Token，我会在对话中提供
```

## 5. 安全建议

- **定期轮换 Token**：每 90 天重新生成一次
- **权限最小化**：只给 `repo` 权限，不要给 admin 权限
- **监控使用**：在 https://github.com/settings/tokens 查看 Token 使用记录
- **紧急撤销**：如果 Token 泄露，立即在该页面删除

## 6. 发布后

- GitHub Actions 自动构建（约 5-10 分钟）
- 构建完成后自动创建 Release
- 用户启动应用时自动检查更新并提示安装
