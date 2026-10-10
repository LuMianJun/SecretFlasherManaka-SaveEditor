#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod save;
use save::{Document, NodePath, Result, SavePlan, Snapshot};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Emitter;

struct AppState {
    document: Mutex<Option<Document>>,
    launch: serde_json::Value,
    pending_save: Mutex<Option<SavePlan>>,
}
fn password() -> String {
    serde_json::from_str::<serde_json::Value>(include_str!("../../../format_config.json")).unwrap()
        ["password"]
        .as_str()
        .unwrap()
        .into()
}
fn with_document<T>(
    state: &tauri::State<AppState>,
    action: impl FnOnce(&mut Document) -> Result<T>,
) -> Result<T> {
    let mut guard = state.document.lock().map_err(|_| "存档状态无法读取")?;
    action(guard.as_mut().ok_or("请先打开存档")?)
}
#[tauri::command]
fn get_metadata() -> serde_json::Value {
    serde_json::from_str(include_str!("../../metadata.json")).unwrap()
}
#[tauri::command]
fn get_launch_options(state: tauri::State<AppState>) -> serde_json::Value {
    state.launch.clone()
}
#[tauri::command]
fn get_document(state: tauri::State<AppState>) -> Result<Option<Snapshot>> {
    Ok(state
        .document
        .lock()
        .map_err(|_| "状态无法读取")?
        .as_ref()
        .map(Document::snapshot))
}
#[tauri::command]
fn load_document(path: String, state: tauri::State<AppState>) -> Result<Snapshot> {
    let doc = Document::load(Path::new(&path), &password())?;
    let snapshot = doc.snapshot();
    *state.pending_save.lock().map_err(|_| "保存状态无法读取")? = None;
    *state.document.lock().map_err(|_| "状态无法读取")? = Some(doc);
    Ok(snapshot)
}
#[tauri::command]
fn open_document(state: tauri::State<AppState>) -> Result<Option<Snapshot>> {
    let mut dialog = rfd::FileDialog::new()
        .set_title("打开 SecretFlasherManaka 存档")
        .add_filter("游戏存档", &["sd"])
        .add_filter("所有文件", &["*"]);
    dialog = dialog.set_directory(game_save_directory());
    match dialog.pick_file() {
        Some(path) => load_document(path.display().to_string(), state).map(Some),
        None => Ok(None),
    }
}
#[tauri::command]
fn replace_value(
    path: NodePath,
    fragment: String,
    state: tauri::State<AppState>,
) -> Result<Snapshot> {
    with_document(&state, |doc| {
        doc.replace(&path, &fragment)?;
        Ok(doc.snapshot())
    })
}
#[tauri::command]
fn add_entry(
    path: NodePath,
    fragment: String,
    key: Option<String>,
    bare: bool,
    state: tauri::State<AppState>,
) -> Result<Snapshot> {
    with_document(&state, |doc| {
        doc.add(&path, &fragment, key.as_deref(), bare)?;
        Ok(doc.snapshot())
    })
}
#[tauri::command]
fn delete_entry(path: NodePath, state: tauri::State<AppState>) -> Result<Snapshot> {
    with_document(&state, |doc| {
        doc.delete(&path)?;
        Ok(doc.snapshot())
    })
}
#[tauri::command]
fn undo_document(state: tauri::State<AppState>) -> Result<Snapshot> {
    with_document(&state, |doc| {
        doc.undo()?;
        Ok(doc.snapshot())
    })
}
#[tauri::command]
fn reset_document(state: tauri::State<AppState>) -> Result<Snapshot> {
    with_document(&state, |doc| {
        doc.reset()?;
        Ok(doc.snapshot())
    })
}
fn game_save_directory() -> PathBuf {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    local
        .and_then(|p| p.parent().map(|parent| parent.join("LocalLow")))
        .or_else(|| profile.map(|p| p.join("AppData").join("LocalLow")))
        .unwrap_or_else(|| PathBuf::from("."))
        // Windows shell dialogs require native separators even though filesystem APIs
        // accept forward slashes. Build each component separately for SetFolder.
        .join("SheableSoft")
        .join("SecretFlasherManaka")
        .join("SaveData")
}
fn suggested_save_name(directory: &Path, kind: &str, source: &Path) -> String {
    if kind == "system" {
        return "s.sd".into();
    }
    (0..20)
        .map(|slot| format!("{slot}.sd"))
        .find(|name| !directory.join(name).exists())
        // All original slots are occupied: keep a valid filename and let the
        // native save dialog ask before overwriting. Never suggest slot 20.
        .unwrap_or_else(|| {
            source
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        })
}
fn store_plan(plan: SavePlan, state: &tauri::State<AppState>) -> Result<SavePlan> {
    *state.pending_save.lock().map_err(|_| "保存状态无法读取")? = Some(plan.clone());
    Ok(plan)
}
#[tauri::command]
fn prepare_save(state: tauri::State<AppState>) -> Result<SavePlan> {
    let plan = with_document(&state, |doc| doc.prepare_save(&doc.source, &password()))?;
    store_plan(plan, &state)
}
#[tauri::command]
fn prepare_save_as(
    destination: Option<String>,
    state: tauri::State<AppState>,
) -> Result<Option<SavePlan>> {
    let path = match destination {
        Some(path) => PathBuf::from(path),
        None => {
            let directory = game_save_directory();
            let filename = with_document(&state, |doc| {
                let snapshot = doc.snapshot();
                if let Some(error) = snapshot.identity_error {
                    if snapshot.identity.kind == "invalid" {
                        return Err(error);
                    }
                }
                Ok(suggested_save_name(
                    &directory,
                    &snapshot.identity.kind,
                    &doc.source,
                ))
            })?;
            match rfd::FileDialog::new()
                .set_title("SecretFlasherManaka 存档另存为")
                .set_directory(directory)
                .set_file_name(filename)
                .add_filter("SecretFlasherManaka 存档", &["sd"])
                .save_file()
            {
                Some(path) => path,
                None => return Ok(None),
            }
        }
    };
    let plan = with_document(&state, |doc| doc.prepare_save(&path, &password()))?;
    store_plan(plan, &state).map(Some)
}
#[tauri::command]
fn commit_save(token: String, state: tauri::State<AppState>) -> Result<Snapshot> {
    let plan = {
        state
            .pending_save
            .lock()
            .map_err(|_| "保存状态无法读取")?
            .take()
            .ok_or("请先确认保存位置")?
    };
    if token != plan.token {
        return Err("保存确认已失效，请重新保存".into());
    }
    with_document(&state, |doc| doc.save(&plan, &password()))
}
#[tauri::command]
fn cancel_save(state: tauri::State<AppState>) -> Result<()> {
    *state.pending_save.lock().map_err(|_| "保存状态无法读取")? = None;
    Ok(())
}
#[tauri::command]
fn close_app(app: tauri::AppHandle) {
    app.exit(0)
}

fn option(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|x| x == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_as_suggests_the_smallest_free_original_slot() {
        let directory = std::env::temp_dir().join(format!(
            "secretflashermanaka-dialog-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let source = Path::new("original-copy.sd");
        assert_eq!(suggested_save_name(&directory, "progress", source), "0.sd");
        for name in ["0.sd", "2.sd", "s.sd", "backup.sd", "20.sd"] {
            std::fs::write(directory.join(name), b"occupied").unwrap();
        }
        assert_eq!(suggested_save_name(&directory, "progress", source), "1.sd");
        assert_eq!(suggested_save_name(&directory, "system", source), "s.sd");
        for slot in 0..20 {
            std::fs::write(directory.join(format!("{slot}.sd")), b"occupied").unwrap();
        }
        assert_eq!(
            suggested_save_name(&directory, "progress", Path::new("3.sd")),
            "3.sd"
        );
        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(suggested_save_name(&directory, "progress", source), "0.sd");
    }
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let source = option(&args, "--source");
    let (document, error) = match source
        .as_ref()
        .map(|path| Document::load(Path::new(path), &password()))
    {
        Some(Ok(doc)) => (Some(doc), None),
        Some(Err(error)) => (None, Some(error)),
        None => (None, None),
    };
    let state = AppState {
        document: Mutex::new(document),
        launch: serde_json::json!({"source":source,"startupError":error,"defaultDirectory":game_save_directory()}),
        pending_save: Mutex::new(None),
    };
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_metadata,
            get_launch_options,
            get_document,
            load_document,
            open_document,
            replace_value,
            add_entry,
            delete_entry,
            undo_document,
            reset_document,
            prepare_save,
            prepare_save_as,
            commit_save,
            cancel_save,
            close_app
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("request-close", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("无法启动存档编辑器");
}
