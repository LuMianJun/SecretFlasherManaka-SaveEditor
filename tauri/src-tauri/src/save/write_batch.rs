//! Stage and verify both files before replacing either; restore on a later failure.
use super::*;
use std::{fs::OpenOptions, io::Write};

pub(super) struct WriteRequest {
    pub destination: PathBuf,
    pub cipher: Vec<u8>,
    pub original_hash: Option<String>,
}

fn current_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn stage(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

pub(super) fn commit(
    requests: &[WriteRequest],
    token: &str,
    password: &str,
    verify_source: impl Fn() -> Result<()>,
) -> Result<()> {
    let mut pending: Vec<(PathBuf, PathBuf, Option<PathBuf>)> = Vec::new();
    let mut preserve_restore = false;
    let result = (|| -> Result<()> {
        for request in requests {
            let destination = &request.destination;
            let name = destination
                .file_name()
                .ok_or("保存文件名无效")?
                .to_string_lossy();
            let temp = destination.with_file_name(format!(".{name}.{token}.tmp"));
            let original = current_bytes(destination)?;
            if original.as_ref().map(|bytes| digest(bytes)) != request.original_hash {
                return Err("保存目标已变化，原文件未覆盖".into());
            }
            let restore = original
                .as_ref()
                .map(|_| destination.with_file_name(format!(".{name}.{token}.restore.tmp")));
            pending.push((destination.clone(), temp.clone(), restore.clone()));
            stage(&temp, &request.cipher)?;
            if decrypt(&fs::read(&temp).map_err(|e| e.to_string())?, password)?
                != decrypt(&request.cipher, password)?
            {
                return Err("写入后的加密校验失败，原文件未覆盖".into());
            }
            if let (Some(restore), Some(original)) = (&restore, &original) {
                stage(restore, original)?;
            }
        }
        verify_source()?;
        for request in requests {
            if current_bytes(&request.destination)?
                .as_ref()
                .map(|bytes| digest(bytes))
                != request.original_hash
            {
                return Err("保存目标已变化，原文件未覆盖".into());
            }
        }
        for (index, (destination, temp, _)) in pending.iter().enumerate() {
            if let Err(error) = fs::rename(temp, destination) {
                for (written, _, restore) in pending[..index].iter().rev() {
                    let rollback = if let Some(restore) = restore {
                        fs::rename(restore, written)
                    } else {
                        fs::remove_file(written)
                    };
                    if let Err(rollback_error) = rollback {
                        // Retain restoration files so failure cannot destroy the old data.
                        preserve_restore = true;
                        return Err(format!("保存失败：{error}；恢复 {} 失败：{rollback_error}。原始文件副本保留在同目录的 .restore.tmp 文件中。", written.display()));
                    }
                }
                return Err(format!("保存失败，已写入文件已恢复：{error}"));
            }
        }
        Ok(())
    })();
    for (_, temp, restore) in pending {
        let _ = fs::remove_file(temp);
        if !preserve_restore {
            if let Some(restore) = restore {
                let _ = fs::remove_file(restore);
            }
        }
    }
    result
}
