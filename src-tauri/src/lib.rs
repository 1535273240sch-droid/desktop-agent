// lib.rs - Tauri 入口
// 注册所有命令 + 系统托盘 + 自动更新检查
// 窗口（无边框透明、居中）由 tauri.conf.json 的 windows 配置创建

mod api_client;
mod file_ops;
mod mcp_bridge;
mod memory;
mod permissions;
mod sandbox;

use tauri::{
    Emitter, Manager, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_updater::UpdaterExt;

// ========================= 应用入口 =========================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // 初始化权限状态（默认安全模式）
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                permissions::init_state(permissions::AccessMode::Safe).await;
                log::info!("permissions initialized (safe mode)");
                // 后台检查更新
                check_for_updates(handle).await;
            });

            // 后台异步部署并启动 nuphus-mcp（不阻塞主窗口显示）
            // 失败仅记录日志，不影响应用启动；用户调用相关工具时会触发重试
            tauri::async_runtime::spawn(async move {
                let bridge = mcp_bridge::McpBridge::shared();
                match bridge.ensure_running().await {
                    Ok(()) => log::info!("[mcp] nuphus-mcp started successfully"),
                    Err(e) => log::warn!("[mcp] ensure_running failed (will retry on next call): {e}"),
                }
            });

            // 系统托盘菜单
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Desktop Agent")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "quit" => {
                        // 退出前销毁所有沙箱容器（使用共享实例以拿到已跟踪的容器列表）
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let mgr = sandbox::SandboxManager::shared();
                            mgr.destroy_all().await;
                            handle.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 单击托盘图标切换主窗口显示
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭按钮最小化到托盘而不是退出
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            // ===== api_client =====
            api_client::api_chat,
            api_client::api_list_models,
            api_client::api_get_usage,
            // ===== file_ops =====
            file_ops::file_read,
            file_ops::file_write,
            file_ops::file_write_binary,
            file_ops::file_search,
            file_ops::file_handle_dropped,
            file_ops::file_secure_store,
            file_ops::file_secure_load,
            file_ops::file_secure_delete,
            file_ops::file_secure_store_keys,
            file_ops::file_secure_load_keys,
            file_ops::read_font_file,
            // ===== sandbox =====
            sandbox::sandbox_detect_docker,
            sandbox::sandbox_ensure_image,
            sandbox::sandbox_create,
            sandbox::sandbox_destroy,
            sandbox::sandbox_execute,
            sandbox::sandbox_pip_install,
            sandbox::sandbox_push_file,
            sandbox::sandbox_pull_file,
            sandbox::sandbox_destroy_all,
            // ===== mcp_bridge =====
            mcp_bridge::mcp_start,
            mcp_bridge::mcp_stop,
            mcp_bridge::mcp_call_tool,
            mcp_bridge::mcp_list_tools,
            mcp_bridge::mcp_get_logs,
            mcp_bridge::mcp_auto_deploy,
            mcp_bridge::mcp_ensure_running,
            mcp_bridge::mcp_status,
            // ===== memory =====
            memory::memory_create,
            memory::memory_update,
            memory::memory_delete,
            memory::memory_get,
            memory::memory_list,
            memory::memory_graph,
            memory::memory_search,
            memory::memory_layout,
            // ===== permissions =====
            permissions::permission_get_mode,
            permissions::permission_set_mode,
            permissions::permission_apply_decision,
            permissions::permission_list_rules,
            permissions::permission_clear_rule,
            permissions::permission_list_logs,
            permissions::permission_list_restore_points,
            permissions::permission_restore,
            permissions::permission_delete_restore,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ========================= 自动更新检查 =========================

async fn check_for_updates(app: tauri::AppHandle) {
    if cfg!(debug_assertions) {
        log::debug!("debug build, skip update check");
        return;
    }

    // 延迟 30 秒后检查（等待应用完全启动）
    tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::warn!("updater not available: {e}");
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!(
                "update available: {} -> {}",
                update.current_version,
                update.version
            );
            // 通知前端有新版本可用
            let _ = app.emit(
                "update-available",
                serde_json::json!({
                    "current": update.current_version,
                    "latest": update.version,
                    "notes": update.body,
                }),
            );
            // 自动下载并安装
            if let Err(e) = update
                .download_and_install(
                    |event, progress| {
                        log::debug!("update download: {:?} {:?}", event, progress);
                    },
                    || {},
                )
                .await
            {
                log::warn!("update install failed: {e}");
                let _ = app.emit(
                    "update-error",
                    serde_json::json!({ "error": format!("{e}") }),
                );
            }
        }
        Ok(None) => {
            log::info!("app is up to date");
        }
        Err(e) => {
            log::warn!("update check failed: {e}");
        }
    }
}
