//! Explicit restoration to a bundled original progress-save contract.
//! Preview is read-only; applying is one undo entry and never writes a save file.
use super::*;
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Rule {
    kind: String,
    #[serde(rename = "ref")]
    reference: Option<String>,
    default: Value,
    nullable: bool,
    fields: BTreeMap<String, Rule>,
    item: Option<Box<Rule>>,
    ids: Option<Vec<String>>,
    strings: Option<Vec<String>>,
    fill: Vec<String>,
    defaults: BTreeMap<String, Value>,
    length: Option<usize>,
    min: Option<f64>,
    max: Option<f64>,
}
#[derive(Deserialize)]
struct Profile {
    name: String,
    definitions: BTreeMap<String, Rule>,
    root: Rule,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairPreview {
    pub profile: String,
    pub content_hash: String,
    pub changes: Vec<RepairChange>,
}
#[derive(Clone, Serialize)]
pub struct RepairChange {
    pub path: NodePath,
    pub operation: &'static str,
    pub reason: &'static str,
    pub before: Option<String>,
    pub after: Option<String>,
}

impl Profile {
    fn resolve<'a>(&'a self, rule: &'a Rule) -> &'a Rule {
        rule.reference
            .as_ref()
            .map_or(rule, |name| &self.definitions[name])
    }
    fn default_value(&self, rule: &Rule) -> Value {
        if !rule.default.is_null() {
            return rule.default.clone();
        }
        let r = self.resolve(rule);
        if !r.default.is_null() {
            return r.default.clone();
        }
        if r.nullable {
            return Value::Null;
        }
        match r.kind.as_str() {
            "object" => r
                .fields
                .iter()
                .map(|(k, v)| (k.clone(), self.default_value(v)))
                .collect(),
            "dict" => {
                let mut values: serde_json::Map<String, Value> = r
                    .fill
                    .iter()
                    .map(|key| (key.clone(), self.default_value(r.item.as_ref().unwrap())))
                    .collect();
                values.extend(r.defaults.clone());
                Value::Object(values)
            }
            "array" => Value::Array(
                (0..r.length.unwrap_or(0))
                    .map(|_| self.default_value(r.item.as_ref().unwrap()))
                    .collect(),
            ),
            _ => Value::Null,
        }
    }
    // New integer dictionary keys keep ES3's numeric-key notation. Existing scalar
    // text is copied from the source, so high-precision numbers are never rounded.
    fn render_value(&self, rule: &Rule, value: &Value) -> String {
        let r = self.resolve(rule);
        match value {
            Value::Object(values) => format!(
                "{{{}}}",
                values
                    .iter()
                    .map(|(key, value)| {
                        let name = if r.kind == "dict" {
                            key.clone()
                        } else {
                            serde_json::to_string(key).unwrap()
                        };
                        let item = if r.kind == "dict" {
                            r.item.as_ref().unwrap().as_ref()
                        } else {
                            &r.fields[key]
                        };
                        format!("{name}:{}", self.render_value(item, value))
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Value::Array(values) => format!(
                "[{}]",
                values
                    .iter()
                    .map(|value| self.render_value(r.item.as_ref().unwrap(), value))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            _ => value.to_string(),
        }
    }
    fn default_text(&self, rule: &Rule) -> String {
        self.render_value(rule, &self.default_value(rule))
    }
    fn repair(
        &self,
        node: Option<&Node>,
        text: &str,
        rule: &Rule,
        path: &mut NodePath,
        changes: &mut Vec<RepairChange>,
    ) -> String {
        let r = self.resolve(rule);
        let Some(node) = node else {
            let after = self.default_text(rule);
            changes.push(RepairChange {
                path: path.clone(),
                operation: "补全",
                reason: "缺失原版字段或必要记录，按默认值补齐",
                before: None,
                after: Some(summary(&after)),
            });
            return after;
        };
        let raw = &text[node.start..node.end];
        if r.nullable && matches!(node.scalar, Scalar::Null) {
            return raw.into();
        }
        let valid = match (&node.scalar, r.kind.as_str()) {
            (Scalar::Object, "object" | "dict")
            | (Scalar::Array, "array")
            | (Scalar::Bool(_), "bool") => true,
            (Scalar::Text(value), "string") => r
                .strings
                .as_ref()
                .is_none_or(|values| values.contains(value)),
            (Scalar::Number(value), "int" | "number") => value.parse::<f64>().is_ok_and(|n| {
                n.is_finite()
                    && (r.kind != "int" || value.parse::<i64>().is_ok())
                    && r.min.is_none_or(|min| n >= min)
                    && r.max.is_none_or(|max| n <= max)
                    && r.ids.as_ref().is_none_or(|ids| ids.contains(value))
            }),
            _ => false,
        };
        if !valid {
            let after = self.default_text(rule);
            changes.push(RepairChange {
                path: path.clone(),
                operation: "重置",
                reason: "类型、结构或编号不符合原版规则，恢复默认值",
                before: Some(summary(raw)),
                after: Some(summary(&after)),
            });
            return after;
        }
        let count = changes.len();
        let output = match r.kind.as_str() {
            "object" | "dict" => {
                let mut entries = Vec::new();
                let mut present = BTreeSet::new();
                for (key, child) in &node.children {
                    let Segment::Key(key) = key else {
                        unreachable!()
                    };
                    path.push(Segment::Key(key.clone()));
                    let child_rule = if r.kind == "object" {
                        r.fields.get(key)
                    } else if r.ids.as_ref().is_none_or(|ids| ids.contains(key)) {
                        r.item.as_deref()
                    } else {
                        None
                    };
                    if let Some(child_rule) = child_rule {
                        present.insert(key.clone());
                        let name = if node.bare_keys.contains(key) {
                            key.clone()
                        } else {
                            serde_json::to_string(key).unwrap()
                        };
                        entries.push(format!(
                            "{name}:{}",
                            self.repair(Some(child), text, child_rule, path, changes)
                        ));
                    } else {
                        changes.push(RepairChange {
                            path: path.clone(),
                            operation: "删除",
                            reason: "不属于当前原版规则的扩展字段或编号",
                            before: Some(summary(&text[child.start..child.end])),
                            after: None,
                        });
                    }
                    path.pop();
                }
                if r.kind == "object" {
                    for (key, child_rule) in &r.fields {
                        if !present.contains(key) {
                            path.push(Segment::Key(key.clone()));
                            entries.push(format!(
                                "{}:{}",
                                serde_json::to_string(key).unwrap(),
                                self.repair(None, text, child_rule, path, changes)
                            ));
                            path.pop();
                        }
                    }
                } else {
                    for key in r.fill.iter().chain(r.defaults.keys()) {
                        if present.insert(key.clone()) {
                            let mut item = r.item.as_ref().unwrap().as_ref().clone();
                            if let Some(value) = r.defaults.get(key) {
                                item.default = value.clone();
                            }
                            path.push(Segment::Key(key.clone()));
                            entries.push(format!(
                                "{key}:{}",
                                self.repair(None, text, &item, path, changes)
                            ));
                            path.pop();
                        }
                    }
                }
                format!("{{{}}}", entries.join(","))
            }
            "array" => {
                let item = r.item.as_ref().unwrap();
                let mut entries = Vec::new();
                for (index, (_, child)) in node.children.iter().enumerate() {
                    path.push(Segment::Index(index));
                    let allowed=r.length.is_none_or(|length|index<length) && (r.length.is_some() || item.ids.as_ref().is_none_or(|ids|matches!(&child.scalar,Scalar::Number(value) if ids.contains(value))));
                    if allowed {
                        entries.push(self.repair(Some(child), text, item, path, changes));
                    } else {
                        changes.push(RepairChange {
                            path: path.clone(),
                            operation: "删除",
                            reason: "超出原版列表长度或包含扩展编号",
                            before: Some(summary(&text[child.start..child.end])),
                            after: None,
                        });
                    }
                    path.pop();
                }
                while entries.len() < r.length.unwrap_or(0) {
                    path.push(Segment::Index(entries.len()));
                    entries.push(self.repair(None, text, item, path, changes));
                    path.pop();
                }
                format!("[{}]", entries.join(","))
            }
            _ => raw.into(),
        };
        if changes.len() == count {
            raw.into()
        } else {
            output
        }
    }
}
fn summary(raw: &str) -> String {
    if let Ok(node) = parse(raw) {
        preview(&node, raw)
    } else {
        raw.chars().take(160).collect()
    }
}
fn profile() -> Result<Profile> {
    serde_json::from_str(include_str!("../../../repair_profile.json"))
        .map_err(|e| format!("原版修复规则无法读取：{e}"))
}
fn plan(doc: &Document) -> Result<(RepairPreview, String)> {
    // File identity is still checked by Document::load. This tool is deliberately
    // progress-only: it must not guess a lost whole save or global system options.
    if !is_progress_root(&doc.root) {
        return Err("首版修复支持可识别的进度存档（0.sd～19.sd 等），暂不修复系统存档 s.sd".into());
    }
    let mut profile = profile()?;
    // A missing slot identity can be recovered from an original manual filename.
    // Other progress filenames retain the original unassigned-slot default.
    let slot = doc
        .source
        .file_stem()
        .and_then(|s| s.to_str())
        .and_then(|s| {
            s.parse::<u32>()
                .ok()
                .filter(|n| *n < 20 && n.to_string() == s)
        })
        .map_or(-1, |n| n as i32);
    profile
        .root
        .fields
        .get_mut("SaveDataSlotIndex")
        .unwrap()
        .fields
        .get_mut("value")
        .unwrap()
        .default = slot.into();
    let mut changes = Vec::new();
    let output = profile.repair(
        Some(&doc.root),
        &doc.text,
        &profile.root,
        &mut vec![],
        &mut changes,
    );
    let repaired = parse(&output)?;
    identity(&repaired)?;
    Ok((
        RepairPreview {
            profile: profile.name,
            content_hash: digest(&doc.bytes()),
            changes,
        },
        output,
    ))
}
impl Document {
    pub fn preview_repair(&self) -> Result<RepairPreview> {
        plan(self).map(|(preview, _)| preview)
    }
    pub fn apply_repair(&mut self, content_hash: &str) -> Result<Snapshot> {
        if digest(&self.bytes()) != content_hash {
            return Err("预览后存档内容已变化，请重新扫描修复".into());
        }
        let (_, output) = plan(self)?;
        self.commit(output)?;
        self.protected_source
            .get_or_insert_with(|| self.source.clone());
        Ok(self.snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(extra: &str) -> (Document, PathBuf) {
        let (mut doc, dir) = super::super::tests::fixture();
        // Normalize a minimal valid original document before injecting fault cases.
        let (_, output) = plan(&doc).unwrap();
        doc.commit(output).unwrap();
        doc.history.clear();
        if !extra.is_empty() {
            doc.add(
                &field_path(&["GameStateData", "value"]),
                extra,
                Some("ExtensionField"),
                false,
            )
            .unwrap();
        }
        (doc, dir)
    }
    #[test]
    fn cosplay_residue_is_removed_from_every_reference_and_missing_defaults_return() {
        let (mut doc, dir) = fixture("");
        let game = field_path(&["GameStateData", "value"]);
        for (field, value) in [
            ("PlayerCosplayPartsDict", "true"),
            ("CosplayPartsOptionDataDict", "{}"),
            ("CosplayPartsReinforceEffectDict", "[1,2,3]"),
            ("CosplayReinforceLockState", "[false,false,false,false]"),
        ] {
            let mut path = game.clone();
            path.push(Segment::Key(field.into()));
            doc.add(&path, value, Some("10033"), true).unwrap();
        }
        let mut path = game.clone();
        path.extend([Segment::Key("LoadoutDatas".into()), Segment::Index(0)]);
        doc.replace(&path,r#"{"CosplayPartsList":[20011,10033],"CostumeList":[],"CosplayPartsOptionDataDict":{10033:{},20011:{}}}"#).unwrap();
        doc.delete(&field_path(&[
            "GameStateData",
            "value",
            "CosplayPartsReinforceEffectDict",
            "20011",
        ]))
        .unwrap();
        doc.replace(
            &field_path(&[
                "GameStateData",
                "value",
                "CosplayReinforceLockState",
                "20011",
            ]),
            "[true]",
        )
        .unwrap();
        let original = doc.text.clone();
        let history = doc.history.len();
        let preview = doc.preview_repair().unwrap();
        assert_eq!(doc.text, original);
        assert_eq!(doc.history.len(), history);
        assert!(preview
            .changes
            .iter()
            .any(|c| c.path.last() == Some(&Segment::Key("10033".into()))));
        doc.apply_repair(&preview.content_hash).unwrap();
        for field in [
            "PlayerCosplayPartsDict",
            "CosplayPartsOptionDataDict",
            "CosplayPartsReinforceEffectDict",
            "CosplayReinforceLockState",
        ] {
            assert!(doc
                .root
                .get(&field_path(&["GameStateData", "value", field, "10033"]))
                .is_err());
        }
        let mut list = path.clone();
        list.push(Segment::Key("CosplayPartsList".into()));
        assert!(!doc
            .root
            .get(&list)
            .unwrap()
            .children
            .iter()
            .any(|(_, node)| matches!(&node.scalar,Scalar::Number(value) if value=="10033")));
        let mut options = path;
        options.extend([
            Segment::Key("CosplayPartsOptionDataDict".into()),
            Segment::Key("10033".into()),
        ]);
        assert!(doc.root.get(&options).is_err());
        assert_eq!(
            doc.root
                .get(&field_path(&[
                    "GameStateData",
                    "value",
                    "CosplayPartsReinforceEffectDict",
                    "20011"
                ]))
                .unwrap()
                .children
                .len(),
            3
        );
        let locks = doc
            .root
            .get(&field_path(&[
                "GameStateData",
                "value",
                "CosplayReinforceLockState",
                "20011",
            ]))
            .unwrap();
        assert_eq!(locks.children.len(), 4);
        assert!(matches!(locks.children[0].1.scalar, Scalar::Bool(true)));
        assert!(doc.preview_repair().unwrap().changes.is_empty());
        assert_eq!(doc.history.len(), history + 1);
        doc.undo().unwrap();
        assert_eq!(doc.text, original);
        assert!(doc.protected_source.is_none());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn precision_progress_and_original_enum_sentinels_are_preserved() {
        let (mut doc, dir) = fixture("12");
        doc.replace(
            &field_path(&["GameStateData", "value", "CurrentRp"]),
            "123456789.1234567890123456789",
        )
        .unwrap();
        doc.add(
            &field_path(&["GameStateData", "value", "MissionAchieveCountDict"]),
            "7",
            Some("60000"),
            true,
        )
        .unwrap();
        doc.add(
            &field_path(&["GameStateData", "value", "MissionAchieveCountDict"]),
            "99",
            Some("999999"),
            true,
        )
        .unwrap();
        let repair = doc.preview_repair().unwrap();
        doc.apply_repair(&repair.content_hash).unwrap();
        assert!(doc.text.contains("123456789.1234567890123456789"));
        assert!(doc
            .root
            .get(&field_path(&["GameStateData", "value", "SkillLevel", "-1"]))
            .is_ok());
        assert!(doc
            .root
            .get(&field_path(&["GameStateData", "value", "ExtensionField"]))
            .is_err());
        assert!(doc
            .root
            .get(&field_path(&[
                "GameStateData",
                "value",
                "MissionAchieveCountDict",
                "999999"
            ]))
            .is_err());
        assert!(
            matches!(&doc.root.get(&field_path(&["GameStateData","value","MissionAchieveCountDict","60000"])).unwrap().scalar,Scalar::Number(n) if n=="7")
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stale_preview_and_system_save_are_rejected_without_mutation() {
        let (mut doc, dir) = fixture("");
        let preview = doc.preview_repair().unwrap();
        doc.replace(&field_path(&["GameStateData", "value", "CurrentRp"]), "5")
            .unwrap();
        let before = doc.text.clone();
        assert!(doc.apply_repair(&preview.content_hash).is_err());
        assert_eq!(doc.text, before);
        doc.commit(r#"{"OptionData":{"__type":"ExposureUnnoticed2.ObjectUI.OptionMenu.OptionData,Assembly-CSharp","value":{}}}"#.into()).unwrap();
        assert!(doc.preview_repair().is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_identity_is_repairable_and_repaired_data_requires_a_separate_copy() {
        let (mut doc, dir) = fixture("");
        doc.delete(&field_path(&["SaveDataSlotIndex"])).unwrap();
        let damaged = doc.bytes();
        let source = dir.join("0.sd");
        fs::write(&source, &damaged).unwrap();
        let mut doc = Document::load(&source, "test").unwrap();
        assert_eq!(doc.snapshot().identity.kind, "invalid");
        let preview = doc.preview_repair().unwrap();
        doc.apply_repair(&preview.content_hash).unwrap();
        assert_eq!(doc.snapshot().identity.slot_index, Some(0));
        assert!(doc.snapshot().repair_requires_copy);
        assert!(doc.prepare_save(&doc.source, "test").is_err());
        let destination = dir.join("repaired.sd");
        let plan = doc.prepare_save(&destination, "test").unwrap();
        doc.save(&plan, "test").unwrap();
        assert!(!doc.snapshot().repair_requires_copy);
        assert_eq!(fs::read(dir.join("0.sd")).unwrap(), damaged);
        assert!(Document::load(&destination, "test")
            .unwrap()
            .preview_repair()
            .unwrap()
            .changes
            .is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn export_cosplay_fault_fixture_when_requested() {
        let Ok(output) = std::env::var("SAVE_REPAIR_FIXTURES_DIR") else {
            return;
        };
        let output = PathBuf::from(output);
        fs::create_dir(&output).expect("Fixture export requires a new directory");
        let (mut doc, dir) = fixture("");
        let password = crate::password();
        let clean = doc.bytes();
        fs::write(output.join("original.sd"), encrypt(&clean, &password, None)).unwrap();
        for (field, value) in [
            ("PlayerCosplayPartsDict", "true"),
            (
                "CosplayPartsOptionDataDict",
                r#"{"r":255,"g":255,"b":255,"shadeColor":0,"materialIndex":0,"boolOption1":false,"boolOption2":false,"invisible":false}"#,
            ),
            ("CosplayPartsReinforceEffectDict", "[0,0,0]"),
            ("CosplayReinforceLockState", "[false,false,false,false]"),
        ] {
            doc.add(
                &field_path(&["GameStateData", "value", field]),
                value,
                Some("10033"),
                true,
            )
            .unwrap();
        }
        let mut loadout = field_path(&["GameStateData", "value", "LoadoutDatas"]);
        loadout.push(Segment::Index(0));
        doc.replace(&loadout,r#"{"CosplayPartsList":[20011,10033],"CostumeList":[],"CosplayPartsOptionDataDict":{10033:{},20011:{}}}"#).unwrap();
        // Only plugin-style residues in this fixture, independently of missing data.
        let residue = doc.bytes();
        fs::write(
            output.join("cosplay-residue.sd"),
            encrypt(&residue, &password, None),
        )
        .unwrap();
        let preview = doc.preview_repair().unwrap();
        doc.apply_repair(&preview.content_hash).unwrap();
        fs::write(
            output.join("cosplay-repaired.sd"),
            encrypt(&doc.bytes(), &password, None),
        )
        .unwrap();
        fs::write(
            output.join("cosplay-repair-plan.json"),
            serde_json::to_vec_pretty(&preview).unwrap(),
        )
        .unwrap();
        // A second fixture combines MOD residue and missing/malformed original data.
        let residue_text = String::from_utf8(residue).unwrap();
        doc.commit(residue_text).unwrap();
        doc.delete(&field_path(&["GameStateData", "value", "SkillLevel"]))
            .unwrap();
        doc.delete(&field_path(&[
            "GameStateData",
            "value",
            "CosplayPartsReinforceEffectDict",
            "20011",
        ]))
        .unwrap();
        doc.replace(
            &field_path(&[
                "GameStateData",
                "value",
                "CosplayReinforceLockState",
                "20011",
            ]),
            "[true]",
        )
        .unwrap();
        doc.add(
            &field_path(&["GameStateData", "value", "MissionAchieveCountDict"]),
            "5",
            Some("79100"),
            true,
        )
        .unwrap();
        doc.add(
            &vec![],
            r#"{"value":{"Example":true}}"#,
            Some("ExampleModData"),
            false,
        )
        .unwrap();
        fs::write(
            output.join("cosplay-and-missing-data.sd"),
            encrypt(&doc.bytes(), &password, None),
        )
        .unwrap();
        let preview = doc.preview_repair().unwrap();
        doc.apply_repair(&preview.content_hash).unwrap();
        fs::write(
            output.join("cosplay-and-missing-repaired.sd"),
            encrypt(&doc.bytes(), &password, None),
        )
        .unwrap();
        fs::write(
            output.join("combined-repair-plan.json"),
            serde_json::to_vec_pretty(&preview).unwrap(),
        )
        .unwrap();
        fs::write(output.join("README.txt"),"Synthetic test saves, not a real gameplay save.\nBased on the supplied Cosplay Loader 2.2.1 DLL: original upper-body IDs end at 10032; injected first part is 10033.\ncosplay-residue.sd contains equipped 10033 and references in options, effects, locks and outfit preset 0. Removing the MOD/master record makes these references unresolved.\ncosplay-and-missing-data.sd additionally removes original SkillLevel and reinforcement 20011, truncates a lock array, adds custom mission 79100 and an extension root.\nRepaired files are produced by the shipped Rust repair engine.\nEncryption/structure and offline original-ID reference checks are tested; actual game loading is NOT claimed.\nDo not overwrite a real save with these fixtures.\n").unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}
