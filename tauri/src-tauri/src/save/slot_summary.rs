//! The original SaveSystem updates only the selected manual slot in s.sd.
use super::*;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemSummaryPlan {
    pub path: String,
    pub slot_index: usize,
    #[serde(skip)]
    source_hash: String,
}

fn manual_slot(destination: &Path, root: &Node) -> Option<usize> {
    if identity(root).ok()?.kind != "progress" {
        return None;
    }
    let stem = destination.file_stem()?.to_str()?;
    let slot = stem.parse::<usize>().ok()?;
    (slot < 20 && stem == slot.to_string()).then_some(slot)
}

pub(super) fn prepare(
    destination: &Path,
    root: &Node,
    password: &str,
) -> Result<Option<SystemSummaryPlan>> {
    let Some(slot_index) = manual_slot(destination, root) else {
        return Ok(None);
    };
    let path = destination.parent().ok_or("保存目录无效")?.join("s.sd");
    if !path.try_exists().map_err(|e| e.to_string())? {
        // A standalone progress copy must not create or guess global options.
        return Ok(None);
    }
    let mut system = Document::load(&path, password)
        .map_err(|e| format!("无法同步同目录的系统存档 s.sd：{e}"))?;
    if identity(&system.root)?.kind != "system" {
        return Err("同目录 s.sd 不是系统存档，未保存".into());
    }
    update(&mut system, root, slot_index, local_datetime_ticks()?)?;
    Ok(Some(SystemSummaryPlan {
        path: system.source.display().to_string(),
        slot_index,
        source_hash: digest(&system.original_cipher),
    }))
}

pub(super) fn write_request(
    plan: &SystemSummaryPlan,
    root: &Node,
    password: &str,
) -> Result<write_batch::WriteRequest> {
    let mut system = Document::load(Path::new(&plan.path), password)?;
    if digest(&system.original_cipher) != plan.source_hash {
        return Err("系统存档已变化，原文件未覆盖".into());
    }
    update(&mut system, root, plan.slot_index, local_datetime_ticks()?)?;
    Ok(write_batch::WriteRequest {
        destination: system.source.clone(),
        cipher: encrypt(&system.bytes(), password, None),
        original_hash: Some(plan.source_hash.clone()),
    })
}

fn numeric<'a>(root: &'a Node, field: &str) -> Result<&'a str> {
    match &root
        .get(&field_path(&["GameStateData", "value", field]))?
        .scalar
    {
        Scalar::Number(value) => Ok(value),
        _ => Err(format!("无法从进度存档读取 {field}，未保存")),
    }
}

fn rank_for_exp(exp: f64) -> i32 {
    // Active MRank.records / MRank.CalcCurrentRank: equality enters the next rank.
    [0.0, 300.0, 800.0, 1500.0, 3000.0, 5000.0, 10000.0, 20000.0]
        .iter()
        .rposition(|threshold| exp >= *threshold)
        .unwrap_or(0) as i32
}

fn update(system: &mut Document, progress: &Node, slot: usize, ticks: u64) -> Result<()> {
    let exp = numeric(progress, "ExposeExp")?
        .parse::<f64>()
        .map_err(|_| "露出经验不是有效数值")?;
    if !exp.is_finite() {
        return Err("露出经验不是有限数值，无法同步等级".into());
    }
    let difficulty = numeric(progress, "DifficultType")?
        .parse::<u32>()
        .map_err(|_| "难度不是有效整数")?;
    if difficulty > 2 {
        return Err("难度超出原版范围，无法同步存档列表".into());
    }
    let play_time = numeric(progress, "StatistisTotalPlayTime")?
        .parse::<u32>()
        .map_err(|_| "总游玩时间必须是原版 UInt32 整数")?;
    for (field, kind, default, value) in [
        (
            "ManualSaveTime",
            "System.DateTime[],mscorlib",
            "{\"ticks\":0}",
            None,
        ),
        (
            "RankData",
            "System.Int32[],mscorlib",
            "0",
            Some(rank_for_exp(exp).to_string()),
        ),
        (
            "DifficultData",
            "ExposureUnnoticed2.ObjectUI.SelectDifficultyPanel.DifficultType[],Assembly-CSharp",
            "0",
            Some(difficulty.to_string()),
        ),
        (
            "TotalPlayTimeData",
            "System.UInt32[],mscorlib",
            "0",
            Some(play_time.to_string()),
        ),
    ] {
        if system.root.get(&field_path(&[field])).is_err() {
            // LoadSystem defaults missing arrays to 20 elements; preserve that behavior.
            let array = vec![default; 20].join(",");
            system.add(
                &vec![],
                &format!("{{\"__type\":\"{kind}\",\"value\":[{array}]}}"),
                Some(field),
                false,
            )?;
        }
        let mut path = field_path(&[field, "value"]);
        let array = system.root.get(&path)?;
        if !matches!(array.scalar, Scalar::Array) || array.children.len() != 20 {
            return Err(format!("系统存档 {field} 不是原版 20 槽位数组，未保存"));
        }
        path.push(Segment::Index(slot));
        if let Some(value) = value {
            system.replace(&path, &value)?;
        } else {
            path.push(Segment::Key("ticks".into()));
            system.replace(&path, &ticks.to_string())?;
        }
    }
    Ok(())
}

// DateTime.Now.Ticks is local wall-clock time, not UTC or a Unix timestamp.
#[cfg(windows)]
fn local_datetime_ticks() -> Result<u64> {
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemTimeAsFileTime(time: *mut FileTime);
        fn FileTimeToLocalFileTime(utc: *const FileTime, local: *mut FileTime) -> i32;
    }
    let mut utc = FileTime::default();
    let mut local = FileTime::default();
    unsafe {
        GetSystemTimeAsFileTime(&mut utc);
        if FileTimeToLocalFileTime(&utc, &mut local) == 0 {
            return Err("无法读取本地保存时间".into());
        }
    }
    Ok((((local.high as u64) << 32) | local.low as u64) + 504_911_232_000_000_000)
}

#[cfg(not(windows))]
fn local_datetime_ticks() -> Result<u64> {
    Err("同步原版保存时间目前仅支持 Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SYSTEM: &str = r#"{"OptionData":{"__type":"ExposureUnnoticed2.ObjectUI.OptionMenu.OptionData,Assembly-CSharp","value":{"Language":2,"Precise":1.234567890123456789}},"TutorialData":{"value":{"Read":true}},"Plugin":{"Keep":42}}"#;

    fn fixtures() -> (Document, PathBuf) {
        let (mut progress, dir) = super::super::tests::fixture();
        for (name, value) in [
            ("ExposeExp", "20000"),
            ("DifficultType", "2"),
            ("StatistisTotalPlayTime", "100962"),
        ] {
            progress
                .add(
                    &field_path(&["GameStateData", "value"]),
                    value,
                    Some(name),
                    false,
                )
                .unwrap();
        }
        let source = dir.join("0.sd");
        fs::write(&source, encrypt(&progress.bytes(), "test", None)).unwrap();
        fs::write(dir.join("s.sd"), encrypt(SYSTEM.as_bytes(), "test", None)).unwrap();
        (Document::load(&source, "test").unwrap(), dir)
    }

    fn leaf<'a>(doc: &'a Document, field: &str, slot: usize) -> &'a str {
        let mut path = field_path(&[field, "value"]);
        path.push(Segment::Index(slot));
        let node = doc.root.get(&path).unwrap();
        &doc.text[node.start..node.end]
    }

    #[test]
    fn rank_thresholds_match_original_inclusive_lookup() {
        for (rank, threshold) in [0.0, 300.0, 800.0, 1500.0, 3000.0, 5000.0, 10000.0, 20000.0]
            .iter()
            .enumerate()
        {
            assert_eq!(rank_for_exp(*threshold), rank as i32);
            if rank > 0 {
                assert_eq!(rank_for_exp(*threshold - 0.001), rank as i32 - 1);
            }
        }
        assert_eq!(rank_for_exp(-1.0), 0);
        assert_eq!(rank_for_exp(583425.0), 7);
    }

    #[test]
    fn only_selected_summary_elements_change_and_missing_arrays_are_initialized() {
        let (progress, dir) = fixtures();
        let mut system = Document::load(&dir.join("s.sd"), "test").unwrap();
        let globals = system.text.clone();
        update(&mut system, &progress.root, 0, 123).unwrap();
        let before = system.text.clone();
        update(&mut system, &progress.root, 1, 639273024000000001).unwrap();
        let expected = before
            .replacen("{\"ticks\":0}", "{\"ticks\":639273024000000001}", 1)
            .replacen("[7,0,", "[7,7,", 1)
            .replacen("[2,0,", "[2,2,", 1)
            .replacen("[100962,0,", "[100962,100962,", 1);
        assert_eq!(system.text, expected);
        assert!(system.text.contains("1.234567890123456789"));
        assert!(system.text.contains(&globals[1..globals.len() - 1]));
        for slot in 2..20 {
            assert_eq!(leaf(&system, "RankData", slot), "0");
            assert_eq!(leaf(&system, "ManualSaveTime", slot), "{\"ticks\":0}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn save_as_updates_target_slot_and_preserves_source_settings_and_other_slots() {
        let (mut progress, dir) = fixtures();
        let old_progress = fs::read(&progress.source).unwrap();
        let old_system = fs::read(dir.join("s.sd")).unwrap();
        let target = dir.join("1.sd");
        let plan = progress.prepare_save(&target, "test").unwrap();
        assert_eq!(plan.system_summary.as_ref().unwrap().slot_index, 1);
        assert_eq!(fs::read(dir.join("s.sd")).unwrap(), old_system); // Preparing/cancelling is read-only.
        progress.save(&plan, "test").unwrap();
        assert_eq!(fs::read(dir.join("0.sd")).unwrap(), old_progress);
        let system = Document::load(&dir.join("s.sd"), "test").unwrap();
        assert_eq!(leaf(&system, "RankData", 1), "7");
        assert_eq!(leaf(&system, "DifficultData", 1), "2");
        assert_eq!(leaf(&system, "TotalPlayTimeData", 1), "100962");
        assert_ne!(leaf(&system, "ManualSaveTime", 1), "{\"ticks\":0}");
        assert_eq!(leaf(&system, "RankData", 0), "0");
        assert!(system.text.contains("1.234567890123456789"));
        assert_eq!(progress.snapshot().identity.slot_index, Some(1));
        assert!(!progress.dirty());
        let plan = progress.prepare_save(&target, "test").unwrap();
        progress.save(&plan, "test").unwrap(); // A clean re-save repairs/refreshes the summary too.
        assert!(!fs::read_dir(&dir).unwrap().any(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|ext| ext == "tmp")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stale_or_appearing_system_save_prevents_both_writes() {
        let (mut progress, dir) = fixtures();
        let target = dir.join("1.sd");
        let plan = progress.prepare_save(&target, "test").unwrap();
        let source = fs::read(&progress.source).unwrap();
        fs::write(
            dir.join("s.sd"),
            encrypt(SYSTEM.replace("42", "43").as_bytes(), "test", None),
        )
        .unwrap();
        let changed_system = fs::read(dir.join("s.sd")).unwrap();
        assert!(progress.save(&plan, "test").is_err());
        assert!(!target.exists());
        assert_eq!(fs::read(&progress.source).unwrap(), source);
        assert_eq!(fs::read(dir.join("s.sd")).unwrap(), changed_system);
        fs::remove_file(dir.join("s.sd")).unwrap();
        let plan = progress.prepare_save(&target, "test").unwrap();
        assert!(plan.system_summary.is_none());
        fs::write(dir.join("s.sd"), encrypt(SYSTEM.as_bytes(), "test", None)).unwrap();
        assert!(progress.save(&plan, "test").is_err());
        assert!(!target.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn standalone_copies_and_direct_system_saves_do_not_sync_other_files() {
        let (mut progress, dir) = fixtures();
        let system_bytes = fs::read(dir.join("s.sd")).unwrap();
        let plan = progress.prepare_save(&dir.join("copy.sd"), "test").unwrap();
        assert!(plan.system_summary.is_none());
        progress.save(&plan, "test").unwrap();
        assert_eq!(fs::read(dir.join("s.sd")).unwrap(), system_bytes);
        let system = Document::load(&dir.join("s.sd"), "test").unwrap();
        assert!(system
            .prepare_save(&system.source, "test")
            .unwrap()
            .system_summary
            .is_none());
        fs::remove_file(dir.join("s.sd")).unwrap();
        let plan = progress.prepare_save(&dir.join("2.sd"), "test").unwrap();
        assert!(plan.system_summary.is_none());
        progress.save(&plan, "test").unwrap();
        assert!(!dir.join("s.sd").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_summary_is_rejected_before_progress_write() {
        let (progress, dir) = fixtures();
        let system = SYSTEM.replacen("{", "{\"RankData\":{\"value\":[0]},", 1);
        fs::write(dir.join("s.sd"), encrypt(system.as_bytes(), "test", None)).unwrap();
        let source = fs::read(&progress.source).unwrap();
        assert!(progress
            .prepare_save(&dir.join("1.sd"), "test")
            .err()
            .unwrap()
            .contains("20 槽位"));
        assert!(!dir.join("1.sd").exists());
        assert_eq!(fs::read(&progress.source).unwrap(), source);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn second_file_replace_failure_restores_progress_and_keeps_draft() {
        use std::os::windows::fs::OpenOptionsExt;
        let (mut progress, dir) = fixtures();
        let source = progress.source.clone();
        let old_progress = fs::read(&source).unwrap();
        let old_system = fs::read(dir.join("s.sd")).unwrap();
        progress
            .replace(&field_path(&["GameStateData", "value", "CurrentRp"]), "10")
            .unwrap();
        let plan = progress.prepare_save(&source, "test").unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(dir.join("s.sd"))
            .unwrap();
        assert!(progress.save(&plan, "test").is_err());
        assert_eq!(fs::read(&source).unwrap(), old_progress);
        assert_eq!(fs::read(dir.join("s.sd")).unwrap(), old_system);
        assert!(progress.dirty());
        drop(locked);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 3); // original.sd, 0.sd, s.sd
        fs::remove_dir_all(dir).unwrap();
    }
}
