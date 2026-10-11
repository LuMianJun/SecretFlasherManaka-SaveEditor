//! Lossless ES3 editing: retain source bytes and replace only the selected span.
mod slot_summary;
mod write_batch;
use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
pub use slot_summary::SystemSummaryPlan;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum Segment {
    Key(String),
    Index(usize),
}
pub type NodePath = Vec<Segment>;

#[derive(Clone, Debug)]
enum Scalar {
    Object,
    Array,
    Number(String),
    Text(String),
    Bool(bool),
    Null,
}
#[derive(Clone, Debug)]
pub struct Node {
    start: usize,
    end: usize,
    member_start: usize,
    scalar: Scalar,
    children: Vec<(Segment, Node)>,
    bare_keys: Vec<String>,
}
impl Node {
    fn kind(&self) -> &'static str {
        match self.scalar {
            Scalar::Object => "object",
            Scalar::Array => "array",
            Scalar::Number(_) => "number",
            Scalar::Text(_) => "string",
            Scalar::Bool(_) => "bool",
            Scalar::Null => "null",
        }
    }
    fn get(&self, path: &[Segment]) -> Result<&Node> {
        match path.split_first() {
            None => Ok(self),
            Some((first, rest)) => self
                .children
                .iter()
                .find(|(key, _)| key == first)
                .ok_or_else(|| "选中的条目已不存在，请重新选择".to_string())?
                .1
                .get(rest),
        }
    }
    fn same(&self, other: &Node) -> bool {
        match (&self.scalar, &other.scalar) {
            (Scalar::Number(a), Scalar::Number(b)) => canonical_number(a) == canonical_number(b),
            (Scalar::Text(a), Scalar::Text(b)) => a == b,
            (Scalar::Bool(a), Scalar::Bool(b)) => a == b,
            (Scalar::Null, Scalar::Null) => true,
            (Scalar::Object, Scalar::Object) | (Scalar::Array, Scalar::Array) => {
                self.children.len() == other.children.len()
                    && self.children.iter().all(|(k, v)| {
                        other
                            .children
                            .iter()
                            .find(|(j, _)| j == k)
                            .is_some_and(|(_, w)| v.same(w))
                    })
            }
            _ => false,
        }
    }
}

fn canonical_number(s: &str) -> String {
    let (mantissa, exponent) = if let Some((a, b)) = s.split_once(['e', 'E']) {
        match b.parse::<i128>() {
            Ok(e) => (a, e),
            Err(_) => return format!("raw:{s}"),
        }
    } else {
        (s, 0i128)
    };
    let negative = mantissa.starts_with('-');
    let unsigned = mantissa.trim_start_matches('-');
    let fractional = unsigned.split_once('.').map_or(0, |(_, b)| b.len()) as i128;
    let digits = unsigned.replace('.', "");
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return "0".into();
    }
    let trimmed = digits.trim_end_matches('0');
    let Some(exp) = exponent
        .checked_sub(fractional)
        .and_then(|e| e.checked_add((digits.len() - trimmed.len()) as i128))
    else {
        return format!("raw:{s}");
    };
    format!("{}{}e{}", if negative { "-" } else { "" }, trimmed, exp)
}

struct Parser<'a> {
    text: &'a str,
    position: usize,
}
impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.position < self.text.len()
            && self.text.as_bytes()[self.position].is_ascii_whitespace()
        {
            self.position += 1;
        }
    }
    fn peek(&mut self) -> Option<u8> {
        self.ws();
        self.text.as_bytes().get(self.position).copied()
    }
    fn take(&mut self, expected: u8) -> Result<()> {
        if self.peek() != Some(expected) {
            return Err(format!(
                "数据位置 {}：应为 {}",
                self.position, expected as char
            ));
        }
        self.position += 1;
        Ok(())
    }
    fn string(&mut self) -> Result<String> {
        self.ws();
        let start = self.position;
        self.position += 1;
        while self.position < self.text.len() {
            match self.text.as_bytes()[self.position] {
                b'"' => {
                    self.position += 1;
                    return serde_json::from_str(&self.text[start..self.position])
                        .map_err(|e| format!("文本格式错误：{e}"));
                }
                b'\\' => self.position += 2,
                _ => self.position += 1,
            }
        }
        Err("文本没有结束引号".into())
    }
    fn token(&mut self) -> &'a str {
        self.ws();
        let start = self.position;
        while self.position < self.text.len() {
            let c = self.text.as_bytes()[self.position];
            if c.is_ascii_whitespace() || b"{}[],:".contains(&c) {
                break;
            }
            self.position += 1;
        }
        &self.text[start..self.position]
    }
    fn node(&mut self, depth: usize) -> Result<Node> {
        if depth > 512 {
            return Err("数据嵌套层数过深".into());
        }
        self.ws();
        let start = self.position;
        let first = self.peek().ok_or("数据意外结束")?;
        let mut node = Node {
            start,
            end: 0,
            member_start: start,
            scalar: Scalar::Null,
            children: Vec::new(),
            bare_keys: Vec::new(),
        };
        match first {
            b'{' | b'[' => {
                let object = first == b'{';
                let closing = if object { b'}' } else { b']' };
                self.position += 1;
                node.scalar = if object {
                    Scalar::Object
                } else {
                    Scalar::Array
                };
                let mut keys = BTreeSet::new();
                if self.peek() != Some(closing) {
                    loop {
                        self.ws();
                        let member_start = self.position;
                        let key = if object {
                            let key = if self.peek() == Some(b'"') {
                                self.string()?
                            } else {
                                let token = self.token();
                                if token.is_empty() {
                                    return Err("无效的字典键".into());
                                }
                                node.bare_keys.push(token.to_string());
                                token.to_string()
                            };
                            if !keys.insert(key.clone()) {
                                return Err(format!("字典键重复：{key}"));
                            }
                            self.take(b':')?;
                            Segment::Key(key)
                        } else {
                            Segment::Index(node.children.len())
                        };
                        let mut child = self.node(depth + 1)?;
                        child.member_start = member_start;
                        node.children.push((key, child));
                        if self.peek() == Some(closing) {
                            break;
                        }
                        self.take(b',')?;
                        if self.peek() == Some(closing) {
                            return Err("不支持尾随逗号".into());
                        }
                    }
                }
                self.take(closing)?;
            }
            b'"' => node.scalar = Scalar::Text(self.string()?),
            _ => {
                let token = self.token();
                node.scalar = match token {
                    "true" => Scalar::Bool(true),
                    "false" => Scalar::Bool(false),
                    "null" => Scalar::Null,
                    _ => {
                        serde_json::from_str::<serde_json::Number>(token)
                            .map_err(|_| format!("无效数值：{token}"))?;
                        Scalar::Number(token.into())
                    }
                };
            }
        }
        node.end = self.position;
        Ok(node)
    }
}
pub fn parse(text: &str) -> Result<Node> {
    let mut parser = Parser { text, position: 0 };
    let node = parser.node(0)?;
    parser.ws();
    if parser.position != text.len() {
        return Err("数据结尾存在多余内容".into());
    }
    Ok(node)
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn key(password: &str, iv: &[u8]) -> [u8; 16] {
    let mut key = [0; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), iv, 100, &mut key);
    key
}
pub fn decrypt(data: &[u8], password: &str) -> Result<Vec<u8>> {
    // An encrypted IV can also start with '{'. Accept plaintext only after parsing it.
    let candidate = data.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(data);
    if let Ok(text) = std::str::from_utf8(candidate) {
        if text.trim_start().starts_with('{') && parse(text).is_ok() {
            return Ok(data.to_vec());
        }
    }
    if data.len() < 32 || data.len() % 16 != 0 {
        return Err("不是受支持的加密存档".into());
    }
    let iv = &data[..16];
    let key = key(password, iv);
    cbc::Decryptor::<aes::Aes128>::new((&key).into(), iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(&data[16..])
        .map_err(|_| "解密失败：加密配置不匹配或文件不完整".into())
}
pub fn encrypt(data: &[u8], password: &str, iv: Option<[u8; 16]>) -> Vec<u8> {
    let iv = iv.unwrap_or_else(|| {
        let mut iv = [0; 16];
        rand::rngs::OsRng.fill_bytes(&mut iv);
        iv
    });
    let key = key(password, &iv);
    let mut encrypted = iv.to_vec();
    encrypted.extend(
        cbc::Encryptor::<aes::Aes128>::new((&key).into(), (&iv).into())
            .encrypt_padded_vec_mut::<Pkcs7>(data),
    );
    encrypted
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    pub path: NodePath,
    pub kind: &'static str,
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    pub children: Vec<Segment>,
    pub bare_keys: Vec<String>,
}
fn flatten(node: &Node, text: &str, path: &mut NodePath, out: &mut Vec<NodeView>) {
    let value = match &node.scalar {
        Scalar::Number(v) | Scalar::Text(v) => Some(serde_json::Value::String(v.clone())),
        Scalar::Bool(v) => Some((*v).into()),
        Scalar::Null => Some(serde_json::Value::Null),
        _ => None,
    };
    out.push(NodeView {
        path: path.clone(),
        kind: node.kind(),
        raw: text[node.start..node.end].into(),
        value,
        children: node.children.iter().map(|(k, _)| k.clone()).collect(),
        bare_keys: node.bare_keys.clone(),
    });
    for (key, child) in &node.children {
        path.push(key.clone());
        flatten(child, text, path, out);
        path.pop();
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Change {
    pub path: NodePath,
    pub operation: &'static str,
    pub before: Option<String>,
    pub after: Option<String>,
}
fn preview(node: &Node, text: &str) -> String {
    match node.scalar {
        Scalar::Object => format!("对象 · {} 项", node.children.len()),
        Scalar::Array => format!("列表 · {} 项", node.children.len()),
        _ => text[node.start..node.end].into(),
    }
}
fn diff(
    old: &Node,
    new: &Node,
    old_text: &str,
    new_text: &str,
    path: &mut NodePath,
    out: &mut Vec<Change>,
) {
    if old.same(new) {
        return;
    }
    if old.kind() == new.kind() && matches!(old.scalar, Scalar::Object | Scalar::Array) {
        let old_map: BTreeMap<_, _> = old.children.iter().map(|(k, n)| (k, n)).collect();
        let new_map: BTreeMap<_, _> = new.children.iter().map(|(k, n)| (k, n)).collect();
        for key in old_map
            .keys()
            .chain(new_map.keys())
            .copied()
            .collect::<BTreeSet<_>>()
        {
            path.push(key.clone());
            match (old_map.get(key), new_map.get(key)) {
                (Some(a), Some(b)) => diff(a, b, old_text, new_text, path, out),
                (Some(a), None) => out.push(Change {
                    path: path.clone(),
                    operation: "删除",
                    before: Some(preview(a, old_text)),
                    after: None,
                }),
                (None, Some(b)) => out.push(Change {
                    path: path.clone(),
                    operation: "新增",
                    before: None,
                    after: Some(preview(b, new_text)),
                }),
                _ => {}
            }
            path.pop();
        }
    } else {
        out.push(Change {
            path: path.clone(),
            operation: "修改",
            before: Some(preview(old, old_text)),
            after: Some(preview(new, new_text)),
        });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub source: String,
    pub source_hash: String,
    pub nodes: Vec<NodeView>,
    pub node_count: usize,
    pub history_length: usize,
    pub dirty: bool,
    pub changed_entries: Vec<Change>,
    pub identity: SaveIdentity,
    pub identity_error: Option<String>,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveIdentity {
    pub kind: String,
    pub slot_index: Option<i32>,
    pub label: String,
}
fn field_path(names: &[&str]) -> NodePath {
    names.iter().map(|v| Segment::Key((*v).into())).collect()
}
fn identity(root: &Node) -> Result<SaveIdentity> {
    if root.get(&field_path(&["GameStateData"])).is_ok() {
        match &root.get(&field_path(&["GameStateData", "__type"]))?.scalar {
            Scalar::Text(t)
                if t == "ExposureUnnoticed2.Scripts.InGame.GameStateData,Assembly-CSharp" =>
            {
                ()
            }
            _ => return Err("游戏数据类型不属于 SecretFlasherManaka".into()),
        }
        match &root
            .get(&field_path(&["SaveDataSlotIndex", "__type"]))
            .map_err(|_| "缺少存档 ID 类型（SaveDataSlotIndex）")?
            .scalar
        {
            Scalar::Text(t) if t == "int" || t == "System.Int32,mscorlib" => (),
            _ => return Err("存档 ID 的原版数据类型必须是整数".into()),
        }
        let slot = match &root
            .get(&field_path(&["SaveDataSlotIndex", "value"]))
            .map_err(|_| "缺少存档 ID（SaveDataSlotIndex）")?
            .scalar
        {
            Scalar::Number(n) => n.parse::<i32>().map_err(|_| "存档 ID 必须是整数")?,
            _ => return Err("缺少有效的存档 ID（SaveDataSlotIndex）".into()),
        };
        if !(-1..20).contains(&slot) {
            return Err("存档 ID 超出原版范围（-1～19）".into());
        }
        Ok(SaveIdentity {
            kind: "progress".into(),
            slot_index: Some(slot),
            label: if slot < 0 {
                "进度存档 · 未分配手动槽位".into()
            } else {
                format!("进度存档 · 槽位 {}", slot + 1)
            },
        })
    } else {
        match &root
            .get(&field_path(&["OptionData", "__type"]))
            .map_err(|_| "无法识别为 SecretFlasherManaka 存档")?
            .scalar
        {
            Scalar::Text(t)
                if t == "ExposureUnnoticed2.ObjectUI.OptionMenu.OptionData,Assembly-CSharp" =>
            {
                ()
            }
            _ => return Err("无法识别为 SecretFlasherManaka 存档".into()),
        }
        if root.get(&field_path(&["SaveDataSlotIndex"])).is_ok() {
            return Err("系统存档不应带有进度存档 ID".into());
        }
        Ok(SaveIdentity {
            kind: "system".into(),
            slot_index: None,
            label: "系统存档 · 设置与存档列表".into(),
        })
    }
}
fn validate_destination(id: &SaveIdentity, path: &Path) -> Result<()> {
    if !path
        .extension()
        .is_some_and(|v| v.eq_ignore_ascii_case("sd"))
    {
        return Err("存档文件扩展名必须为 .sd".into());
    }
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if stem == "s" {
        if id.kind != "system" {
            return Err("s.sd 只能保存系统存档，不能写入进度存档".into());
        }
    } else if !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()) {
        let slot = stem.parse::<i32>().map_err(|_| "手动存档编号无效")?;
        if !(0..20).contains(&slot) || stem != slot.to_string() {
            return Err("手动存档文件名应为 0.sd～19.sd".into());
        }
        if id.kind != "progress" || id.slot_index != Some(slot) {
            return Err(format!(
                "存档 ID 与文件名不一致：{} 要求 ID {}。保存到该槽位时会自动匹配编号。",
                path.file_name().unwrap_or_default().to_string_lossy(),
                slot
            ));
        }
    }
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePlan {
    pub token: String,
    pub destination: String,
    pub exists: bool,
    pub identity: SaveIdentity,
    pub changed_count: usize,
    pub system_summary: Option<SystemSummaryPlan>,
    target_hash: Option<String>,
    content_hash: String,
}
pub struct Document {
    pub source: PathBuf,
    original_cipher: Vec<u8>,
    pub original_text: String,
    original_root: Node,
    pub text: String,
    root: Node,
    history: Vec<String>,
    bom: bool,
}
impl Document {
    pub fn load(source: &Path, password: &str) -> Result<Self> {
        let source = source
            .canonicalize()
            .map_err(|e| format!("无法打开文件：{e}"))?;
        let original_cipher = fs::read(&source).map_err(|e| e.to_string())?;
        let bytes = decrypt(&original_cipher, password)?;
        let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
        let text = String::from_utf8(if bom { bytes[3..].to_vec() } else { bytes })
            .map_err(|_| "存档不是 UTF-8 文本")?;
        let root = parse(&text)?;
        if !matches!(root.scalar, Scalar::Object) {
            return Err("存档顶层必须是对象".into());
        }
        identity(&root)?;
        Ok(Self {
            source,
            original_cipher,
            original_text: text.clone(),
            original_root: root.clone(),
            text,
            root,
            history: Vec::new(),
            bom,
        })
    }
    pub fn bytes(&self) -> Vec<u8> {
        let mut data = if self.bom {
            vec![0xef, 0xbb, 0xbf]
        } else {
            Vec::new()
        };
        data.extend(self.text.as_bytes());
        data
    }
    pub fn changes(&self) -> Vec<Change> {
        let mut changes = Vec::new();
        diff(
            &self.original_root,
            &self.root,
            &self.original_text,
            &self.text,
            &mut Vec::new(),
            &mut changes,
        );
        changes
    }
    pub fn dirty(&self) -> bool {
        self.text != self.original_text
    }
    pub fn snapshot(&self) -> Snapshot {
        let mut nodes = Vec::new();
        flatten(&self.root, &self.text, &mut Vec::new(), &mut nodes);
        let id = identity(&self.root);
        let identity_error = id
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|id| validate_destination(id, &self.source))
            .err();
        Snapshot {
            source: self
                .source
                .display()
                .to_string()
                .trim_start_matches("\\\\?\\")
                .into(),
            source_hash: digest(&self.original_cipher),
            node_count: nodes.len(),
            nodes,
            history_length: self.history.len(),
            dirty: self.dirty(),
            changed_entries: self.changes(),
            identity: id.unwrap_or(SaveIdentity {
                kind: "invalid".into(),
                slot_index: None,
                label: "存档 ID 无效".into(),
            }),
            identity_error,
        }
    }
    fn commit(&mut self, text: String) -> Result<()> {
        let root = parse(&text)?;
        if !matches!(root.scalar, Scalar::Object) {
            return Err("存档顶层必须是对象".into());
        }
        if text != self.text {
            self.history.push(std::mem::replace(&mut self.text, text));
            self.root = root;
        }
        Ok(())
    }
    pub fn replace(&mut self, path: &[Segment], fragment: &str) -> Result<()> {
        parse(fragment)?;
        let node = self.root.get(path)?;
        self.commit(format!(
            "{}{}{}",
            &self.text[..node.start],
            fragment,
            &self.text[node.end..]
        ))
    }
    pub fn add(
        &mut self,
        path: &[Segment],
        fragment: &str,
        key: Option<&str>,
        bare: bool,
    ) -> Result<()> {
        parse(fragment)?;
        let node = self.root.get(path)?;
        let entry = match node.scalar {
            Scalar::Object => {
                let key = key.ok_or("请输入对象键")?;
                if node
                    .children
                    .iter()
                    .any(|(k, _)| k == &Segment::Key(key.into()))
                {
                    return Err("对象键已存在".into());
                }
                let encoded = if bare {
                    serde_json::from_str::<serde_json::Number>(key)
                        .map_err(|_| "数字键必须填写有效数字")?;
                    key.to_string()
                } else {
                    serde_json::to_string(key).unwrap()
                };
                format!("{encoded}: {fragment}")
            }
            Scalar::Array => fragment.to_string(),
            _ => return Err("只能向对象或列表新增条目".into()),
        };
        let at = node.end - 1;
        let comma = if node.children.is_empty() { "" } else { "," };
        self.commit(format!(
            "{}{comma}\n{entry}\n{}",
            &self.text[..at],
            &self.text[at..]
        ))
    }
    pub fn delete(&mut self, path: &[Segment]) -> Result<()> {
        let (key, parent_path) = path.split_last().ok_or("不能删除存档根节点")?;
        let parent = self.root.get(parent_path)?;
        let index = parent
            .children
            .iter()
            .position(|(k, _)| k == key)
            .ok_or("条目不存在")?;
        let node = &parent.children[index].1;
        let mut start = node.member_start;
        let mut end = node.end;
        if index + 1 < parent.children.len() {
            end = parent.children[index + 1].1.member_start;
        } else if index > 0 {
            start = parent.children[index - 1].1.end;
        }
        self.commit(format!("{}{}", &self.text[..start], &self.text[end..]))
    }
    pub fn undo(&mut self) -> Result<()> {
        if let Some(text) = self.history.last() {
            let root = parse(text)?;
            self.root = root;
            self.text = self.history.pop().unwrap();
        }
        Ok(())
    }
    pub fn reset(&mut self) -> Result<()> {
        self.commit(self.original_text.clone())
    }
    fn verify_source(&self) -> Result<()> {
        if fs::read(&self.source).map_err(|e| e.to_string())? != self.original_cipher {
            return Err("当前文件已被其他程序修改，请重新打开后保存".into());
        }
        Ok(())
    }
    // Prepare the target slot without changing the open document or its undo history.
    // Cancelling a file dialog/confirmation must leave the source identity intact.
    fn content_for_destination(&self, destination: &Path) -> Result<(String, Node, SaveIdentity)> {
        let id = identity(&self.root)?;
        let mut text = self.text.clone();
        if id.kind == "progress" {
            let stem = destination
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy();
            if let Ok(slot) = stem.parse::<i32>() {
                if (0..20).contains(&slot)
                    && stem == slot.to_string()
                    && id.slot_index != Some(slot)
                {
                    let node = self
                        .root
                        .get(&field_path(&["SaveDataSlotIndex", "value"]))?;
                    text.replace_range(node.start..node.end, &slot.to_string());
                }
            }
        }
        let root = parse(&text)?;
        let id = identity(&root)?;
        validate_destination(&id, destination)?;
        Ok((text, root, id))
    }
    pub fn prepare_save(&self, destination: &Path, password: &str) -> Result<SavePlan> {
        self.verify_source()?;
        let destination = if destination.exists() {
            destination.canonicalize().map_err(|e| e.to_string())?
        } else {
            let absolute = if destination.is_absolute() {
                destination.to_path_buf()
            } else {
                std::env::current_dir()
                    .map_err(|e| e.to_string())?
                    .join(destination)
            };
            let parent = absolute
                .parent()
                .ok_or("保存目录无效")?
                .canonicalize()
                .map_err(|e| format!("保存目录不可用：{e}"))?;
            parent.join(absolute.file_name().ok_or("文件名无效")?)
        };
        let (text, root, id) = self.content_for_destination(&destination)?;
        let target_hash = if destination.exists() {
            let target = Document::load(&destination, password)?;
            let target_id = identity(&target.root)?;
            if target_id.kind != id.kind || target_id.slot_index != id.slot_index {
                return Err("目标文件的存档 ID 或类型与当前数据不同，不能覆盖".into());
            }
            Some(digest(&target.original_cipher))
        } else {
            None
        };
        let mut changes = Vec::new();
        diff(
            &self.original_root,
            &root,
            &self.original_text,
            &text,
            &mut Vec::new(),
            &mut changes,
        );
        Ok(SavePlan {
            token: format!("{:032x}", rand::random::<u128>()),
            destination: destination
                .display()
                .to_string()
                .trim_start_matches("\\\\?\\")
                .into(),
            exists: target_hash.is_some(),
            identity: id,
            changed_count: changes.len(),
            system_summary: slot_summary::prepare(&destination, &root, password)?,
            target_hash,
            content_hash: digest(&self.bytes()),
        })
    }
    pub fn save(&mut self, plan: &SavePlan, password: &str) -> Result<Snapshot> {
        if digest(&self.bytes()) != plan.content_hash {
            return Err("确认后编辑内容发生变化，请重新保存".into());
        }
        let destination = Path::new(&plan.destination);
        let current = self.prepare_save(destination, password)?;
        if current.target_hash != plan.target_hash {
            return Err("确认后目标文件发生变化，请重新保存".into());
        }
        if current.system_summary != plan.system_summary {
            return Err("确认后系统存档发生变化，请重新保存".into());
        }
        let (text, root, _) = self.content_for_destination(destination)?;
        let mut bytes = if self.bom {
            vec![0xef, 0xbb, 0xbf]
        } else {
            Vec::new()
        };
        bytes.extend(text.as_bytes());
        let cipher = encrypt(&bytes, password, None);
        if decrypt(&cipher, password)? != bytes {
            return Err("加密校验失败，文件未保存".into());
        }
        let mut writes = vec![write_batch::WriteRequest {
            destination: destination.to_path_buf(),
            cipher: cipher.clone(),
            original_hash: plan.target_hash.clone(),
        }];
        if let Some(summary) = &plan.system_summary {
            writes.push(slot_summary::write_request(summary, &root, password)?);
        }
        write_batch::commit(&writes, &plan.token, password, || self.verify_source())?;
        // Saved data becomes the new baseline; subsequent edits save to this file.
        self.source = destination
            .canonicalize()
            .unwrap_or_else(|_| destination.to_path_buf());
        self.original_cipher = cipher;
        self.text = text;
        self.root = root;
        self.original_text = self.text.clone();
        self.original_root = self.root.clone();
        self.history.clear();
        Ok(self.snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const TEXT: &str = r#"{"SaveDataSlotIndex":{"__type":"int","value":0},"GameStateData":{"__type":"ExposureUnnoticed2.Scripts.InGame.GameStateData,Assembly-CSharp","value":{"CurrentRp":55372,"HighPrecision":1.2345678901234567890123456789,"Items":{1:5,-1:0},"List":[true,"中文",null],"Unknown":{"x":2}}}}"#;
    pub(super) fn fixture() -> (Document, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "secretflashermanaka-rust-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("original.sd");
        fs::write(&path, encrypt(TEXT.as_bytes(), "test", None)).unwrap();
        (Document::load(&path, "test").unwrap(), dir)
    }
    fn path(field: &str) -> NodePath {
        vec![
            Segment::Key("GameStateData".into()),
            Segment::Key("value".into()),
            Segment::Key(field.into()),
        ]
    }
    #[test]
    fn crypto_roundtrip_and_fixed_iv() {
        let iv = [7; 16];
        let a = encrypt(TEXT.as_bytes(), "test", Some(iv));
        assert_eq!(decrypt(&a, "test").unwrap(), TEXT.as_bytes());
        assert_eq!(a, encrypt(TEXT.as_bytes(), "test", Some(iv)));
        assert!(decrypt(&a, "wrong").is_err());
    }
    #[test]
    fn ciphertext_iv_can_start_with_brace() {
        let mut iv = [7; 16];
        iv[0] = b'{';
        let encrypted = encrypt(TEXT.as_bytes(), "test", Some(iv));
        assert_eq!(decrypt(&encrypted, "test").unwrap(), TEXT.as_bytes());
    }
    #[test]
    fn only_selected_span_changes() {
        let (mut d, dir) = fixture();
        d.replace(&path("CurrentRp"), "55373").unwrap();
        assert_eq!(d.text, TEXT.replacen("55372", "55373", 1));
        assert_eq!(d.changes().len(), 1);
        d.undo().unwrap();
        assert_eq!(d.text, TEXT);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn reject_invalid_without_mutation() {
        let (mut d, dir) = fixture();
        for s in ["NaN", "1 tail", r#"{"x":1,"x":2}"#, "[1,]"] {
            assert!(d.replace(&path("CurrentRp"), s).is_err());
            assert_eq!(d.text, TEXT);
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn dictionary_and_array_add_delete() {
        let (mut d, dir) = fixture();
        let p = path("Items");
        d.add(&p, "7", Some("42"), true).unwrap();
        assert!(d.root.get(&p).unwrap().bare_keys.contains(&"42".into()));
        let mut item = p.clone();
        item.push(Segment::Key("1".into()));
        d.delete(&item).unwrap();
        item.pop();
        item.push(Segment::Key("42".into()));
        d.delete(&item).unwrap();
        item.pop();
        item.push(Segment::Key("-1".into()));
        d.delete(&item).unwrap();
        assert_eq!(d.root.get(&p).unwrap().children.len(), 0);
        let p = path("List");
        let mut item = p.clone();
        item.push(Segment::Index(1));
        d.delete(&item).unwrap();
        item.pop();
        item.push(Segment::Index(0));
        d.delete(&item).unwrap();
        d.delete(&item).unwrap();
        d.add(&p, r#"{"nested":[1,true]}"#, None, false).unwrap();
        assert_eq!(d.root.get(&p).unwrap().children.len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn primitives_unicode_and_unknown_survive() {
        let (mut d, dir) = fixture();
        let mut p = path("List");
        p.push(Segment::Index(1));
        d.replace(&p, &serde_json::to_string("中文\n引号\"🙂").unwrap())
            .unwrap();
        assert!(d.text.contains("1.2345678901234567890123456789"));
        assert!(d.text.contains(r#""Unknown":{"x":2}"#));
        assert_eq!(d.changes().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn save_replaces_file_and_refreshes_baseline() {
        let (mut d, dir) = fixture();
        let source = d.source.clone();
        for rp in ["55373", "55374"] {
            d.replace(&path("CurrentRp"), rp).unwrap();
            let plan = d.prepare_save(&source, "test").unwrap();
            let snapshot = d.save(&plan, "test").unwrap();
            assert!(!snapshot.dirty);
            assert!(snapshot.changed_entries.is_empty());
            assert_eq!(snapshot.history_length, 0);
            let reopened = Document::load(&source, "test").unwrap();
            assert_eq!(reopened.bytes(), d.bytes());
        }
        assert!(!dir.join("original.sd.verification.json").exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn save_as_adopts_target_and_preserves_old_file() {
        let (mut d, dir) = fixture();
        let old = d.source.clone();
        let cipher = fs::read(&old).unwrap();
        d.replace(&path("CurrentRp"), "55373").unwrap();
        let target = dir.join("0.sd");
        let plan = d.prepare_save(&target, "test").unwrap();
        d.save(&plan, "test").unwrap();
        assert_eq!(d.source, target.canonicalize().unwrap());
        assert_eq!(fs::read(old).unwrap(), cipher);
        d.replace(&path("CurrentRp"), "55374").unwrap();
        let plan = d.prepare_save(&target, "test").unwrap();
        d.save(&plan, "test").unwrap();
        assert_eq!(Document::load(&target, "test").unwrap().bytes(), d.bytes());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stale_source_target_and_draft_do_not_overwrite() {
        let (mut d, dir) = fixture();
        let target = dir.join("copy.sd");
        let plan = d.prepare_save(&target, "test").unwrap();
        d.replace(&path("CurrentRp"), "8").unwrap();
        assert!(d.save(&plan, "test").is_err());
        assert!(!target.exists());
        let plan = d.prepare_save(&target, "test").unwrap();
        fs::write(&target, b"created elsewhere").unwrap();
        assert!(d.save(&plan, "test").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"created elsewhere");
        fs::write(&d.source, b"source changed").unwrap();
        assert!(d.prepare_save(&dir.join("new.sd"), "test").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn slot_id_filename_and_existing_target_checks() {
        let (mut d, dir) = fixture();
        let plan = d.prepare_save(&dir.join("1.sd"), "test").unwrap();
        assert_eq!(plan.identity.slot_index, Some(1));
        assert_eq!(plan.changed_count, 1);
        assert_eq!(d.text, TEXT);
        assert_eq!(d.snapshot().identity.slot_index, Some(0));
        assert!(!d.dirty());
        assert!(d.prepare_save(&dir.join("20.sd"), "test").is_err());
        assert!(d.prepare_save(&dir.join("s.sd"), "test").is_err());
        for name in ["0.sd", "backup.sd"] {
            assert!(d.prepare_save(&dir.join(name), "test").is_ok());
        }
        let target = dir.join("other.sd");
        fs::write(
            &target,
            encrypt(
                TEXT.replace(
                    "\"__type\":\"int\",\"value\":0",
                    "\"__type\":\"int\",\"value\":1",
                )
                .as_bytes(),
                "test",
                None,
            ),
        )
        .unwrap();
        assert!(d.prepare_save(&target, "test").is_err());
        for id in ["-2", "20", "0.5", "\"0\""] {
            d.replace(&field_path(&["SaveDataSlotIndex", "value"]), id)
                .unwrap();
            assert!(d.prepare_save(&dir.join("0.sd"), "test").is_err());
            assert!(d.snapshot().identity_error.is_some());
        }
        d.delete(&field_path(&["SaveDataSlotIndex"])).unwrap();
        assert!(d.prepare_save(&dir.join("backup.sd"), "test").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn save_as_assigns_target_slot_only_after_success() {
        let (mut d, dir) = fixture();
        let original_cipher = fs::read(&d.source).unwrap();
        let source = d.source.clone();
        d.replace(&path("CurrentRp"), "8").unwrap();
        let target = dir.join("1.sd");
        let plan = d.prepare_save(&target, "test").unwrap();
        assert_eq!(plan.changed_count, 2);
        assert_eq!(d.snapshot().identity.slot_index, Some(0));
        let snapshot = d.save(&plan, "test").unwrap();
        assert_eq!(snapshot.identity.slot_index, Some(1));
        assert!(!snapshot.dirty);
        let expected = TEXT
            .replacen("\"value\":0", "\"value\":1", 1)
            .replacen("55372", "8", 1);
        assert_eq!(Document::load(&target, "test").unwrap().text, expected);
        assert_eq!(d.text, expected);
        assert_eq!(fs::read(source).unwrap(), original_cipher);
        assert_eq!(
            d.prepare_save(&dir.join("named-copy.sd"), "test")
                .unwrap()
                .identity
                .slot_index,
            Some(1)
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn save_as_can_overwrite_another_valid_slot_and_failure_keeps_identity() {
        let (mut d, dir) = fixture();
        let target = dir.join("1.sd");
        let target_text = TEXT.replacen("\"value\":0", "\"value\":1", 1);
        fs::write(&target, encrypt(target_text.as_bytes(), "test", None)).unwrap();
        let plan = d.prepare_save(&target, "test").unwrap();
        fs::write(&target, b"changed after confirmation").unwrap();
        assert!(d.save(&plan, "test").is_err());
        assert_eq!(d.text, TEXT);
        fs::write(&target, encrypt(target_text.as_bytes(), "test", None)).unwrap();
        let plan = d.prepare_save(&target, "test").unwrap();
        d.save(&plan, "test").unwrap();
        assert_eq!(d.snapshot().identity.slot_index, Some(1));
        assert_eq!(Document::load(&target, "test").unwrap().text, target_text);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn system_save_has_no_progress_id() {
        let (_, dir) = fixture();
        let text = r#"{"OptionData":{"__type":"ExposureUnnoticed2.ObjectUI.OptionMenu.OptionData,Assembly-CSharp","value":{"Language":2}},"TutorialData":{"value":{}}}"#;
        let source = dir.join("system.sd");
        fs::write(&source, encrypt(text.as_bytes(), "test", None)).unwrap();
        let mut d = Document::load(&source, "test").unwrap();
        assert!(d.prepare_save(&dir.join("0.sd"), "test").is_err());
        let target = dir.join("s.sd");
        let plan = d.prepare_save(&target, "test").unwrap();
        d.save(&plan, "test").unwrap();
        assert_eq!(d.snapshot().identity.slot_index, None);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn decimal_comparison_is_exact() {
        assert!(parse("1.00").unwrap().same(&parse("1e0").unwrap()));
        assert!(!parse("1.234567890123456789")
            .unwrap()
            .same(&parse("1.234567890123456788").unwrap()));
        assert!(parse("-0").unwrap().same(&parse("0.0").unwrap()));
    }
}
