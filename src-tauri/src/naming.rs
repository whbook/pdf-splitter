//! 文件名整理。界面侧的 `src/lib/validate.ts` 必须使用同一套规则。

pub const MAX_TITLE_CHARS: usize = 80;
pub const MAX_PATH_CHARS: usize = 240;
pub const SPLIT_DIR_SUFFIX: &str = "-章节拆分";

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

pub fn sanitize_component(input: &str) -> String {
    let mut cleaned = String::new();
    for ch in input.chars() {
        if ch.is_control() || matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            continue;
        }
        cleaned.push(ch);
    }
    let mut text = cleaned.trim().to_string();
    while text.ends_with('.') || text.ends_with(' ') {
        text.pop();
    }
    text = text.trim().to_string();
    if text.is_empty() {
        return text;
    }
    let stem = text.split('.').next().unwrap_or(text.as_str());
    if is_reserved(&text) || is_reserved(stem) {
        text.push('_');
    }
    text
}

fn is_reserved(name: &str) -> bool {
    RESERVED.iter().any(|item| name.eq_ignore_ascii_case(item))
}

pub fn truncate_chars(input: &str, max_chars: usize) -> String {
    input.chars().take(max_chars).collect()
}

pub fn char_len(input: &str) -> usize {
    input.chars().count()
}

pub fn split_directory_name(book_title: &str) -> String {
    format!("{book_title}{SPLIT_DIR_SUFFIX}")
}

pub const HEADING_UNITS: &[&str] = &["卷", "篇", "章", "节", "回"];

pub fn normalize_unit(unit: &str) -> &str {
    let trimmed = unit.trim();
    if HEADING_UNITS.contains(&trimmed) {
        trimmed
    } else {
        ""
    }
}

pub fn padded_sequence(sequence: u32, total: usize) -> String {
    let width = if total >= 100 { 3 } else { 2 };
    format!("{sequence:0width$}")
}

/// 选了「章」等单位时，预览是「第1章」或「第1章-封面」。没选时是「01-用户标题」。
pub fn title_preview(unit: &str, sequence: u32, total: usize, user_title: &str) -> String {
    if unit.is_empty() {
        format!("{}-{user_title}", padded_sequence(sequence, total))
    } else if user_title.is_empty() {
        format!("第{sequence}{unit}")
    } else {
        format!("第{sequence}{unit}-{user_title}")
    }
}

pub fn chapter_filename(book_title: &str, preview: &str) -> String {
    format!("{book_title}-{preview}.pdf")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_illegal_characters_and_trailing_dots() {
        assert_eq!(sanitize_component("  魏书:卷一?  "), "魏书卷一");
        assert_eq!(sanitize_component("目录..."), "目录");
        assert_eq!(sanitize_component("a\\b/c"), "abc");
        assert_eq!(sanitize_component("   ... "), "");
        assert_eq!(sanitize_component("含\u{0001}控制符"), "含控制符");
    }

    #[test]
    fn appends_underscore_to_reserved_names() {
        assert_eq!(sanitize_component("con"), "con_");
        assert_eq!(sanitize_component("NUL"), "NUL_");
        assert_eq!(sanitize_component("COM1.txt"), "COM1.txt_");
        assert_eq!(sanitize_component("三国志"), "三国志");
    }
}
